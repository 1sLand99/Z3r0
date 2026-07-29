import asyncio
from uuid import uuid4

from sqlalchemy import delete, exists, func, text, update
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from core.agent.constants import DEFAULT_AGENT_CODE
from core.runtime.session import get_agent_pool, get_agent_registry
from database import get_async_session
from logger import get_logger
from model.agent.sessions import AgentSessionMeta
from model.system_user.users import SystemUser
from model.work_project.projects import WorkProject, WorkProjectOwner
from schema.agent.events import AgentTimelineItemSchema
from schema.agent.sessions import AgentSessionSummarySchema, SessionType
from schema.system_user.users import SystemUserRole
from service.agent.event_log import fetch_timeline_page
from service.agent.session_state import get_session_meta, mark_sessions_stopped
from service.common.pagination import Page, paginate_statement
from service.system_user.locking import lock_system_user_lifecycle
from utils.sdk_tables import agent_messages, agent_sessions


logger = get_logger(__name__)

_TITLE_MAX_LEN = 80
DEFAULT_TIMELINE_PAGE_SIZE = 80
_SESSION_TEARDOWN_BATCH_SIZE = 32


async def create_session(user_id: int) -> str:
    session_id = str(uuid4())
    async with get_async_session() as session:
        await lock_system_user_lifecycle(session, user_id)
        if await session.get(SystemUser, user_id) is None:
            raise PermissionError("system user no longer exists")
        await ensure_sdk_session_row(session, session_id)
        session.add(AgentSessionMeta(
            session_id=session_id,
            session_type=SessionType.CHAT,
            agent_code=DEFAULT_AGENT_CODE,
            owner_id=user_id,
        ))
        await session.commit()
    return session_id


async def update_session_title(
    session_id: str,
    title: str,
    user_id: int,
    user_role: SystemUserRole,
) -> AgentSessionSummarySchema | None:
    async with get_async_session() as session:
        meta = await session.get(AgentSessionMeta, session_id)
        if meta is None or not await _can_access_meta(session, meta, user_id, user_role):
            return None
        meta.title = title
        session.add(meta)
        await session.commit()
    return await session_summary(session_id, user_id=user_id, user_role=user_role)


async def ensure_chat_session_meta(
    session_id: str,
    user_text: str,
    requested_agent_code: str | None,
    user_id: int,
    user_role: SystemUserRole,
) -> str:
    # resolution: override > sticky > default
    valid = set(get_agent_registry().codes())
    override = requested_agent_code

    async with get_async_session() as session:
        meta = await session.get(AgentSessionMeta, session_id)
        if meta is None or not await _can_access_meta(session, meta, user_id, user_role):
            raise PermissionError("agent session not found")
        existing = meta.agent_code if meta and meta.agent_code in valid else None
        resolved = override or existing or DEFAULT_AGENT_CODE

        if meta.agent_code != resolved:
            meta.agent_code = resolved
            if not meta.title:
                meta.title = _truncate(user_text)
            session.add(meta)
        elif not meta.title:
            meta.title = _truncate(user_text)
            session.add(meta)
        await session.commit()

    return resolved


async def list_sessions(
    page: int = 1,
    size: int = 10,
    user_id: int = 0,
    user_role: SystemUserRole = SystemUserRole.USER,
    project_id: int | None = None,
) -> Page[AgentSessionSummarySchema]:
    return await _list_sessions(
        page=page,
        size=size,
        user_id=user_id,
        user_role=user_role,
        project_id=project_id,
    )


async def session_summary(
    session_id: str,
    user_id: int,
    user_role: SystemUserRole,
) -> AgentSessionSummarySchema | None:
    async with get_async_session() as session:
        if not await _can_access_session(session, session_id, user_id, user_role):
            return None
    return await _session_summary_by_id(session_id)


async def _list_sessions(
    page: int,
    size: int,
    user_id: int,
    user_role: SystemUserRole,
    project_id: int | None = None,
) -> Page[AgentSessionSummarySchema]:
    meta_table = AgentSessionMeta.__table__
    stmt = _session_list_statement().order_by(
        agent_sessions.c.updated_at.desc(),
        agent_sessions.c.session_id.desc(),
    )
    stmt = stmt.where(meta_table.c.is_deleting.is_(False))
    if project_id is None:
        stmt = stmt.where(
            meta_table.c.project_id.is_(None),
            meta_table.c.owner_id == user_id,
        )
    else:
        stmt = stmt.where(meta_table.c.project_id == project_id)
        if user_role != SystemUserRole.ADMIN:
            stmt = stmt.where(
                exists()
                .where(WorkProjectOwner.project_id == project_id)
                .where(WorkProjectOwner.user_id == user_id)
            )

    page_result = await paginate_statement(stmt, page=page, size=size)
    rows = page_result.items
    if not rows:
        return Page(page=page, size=size, total=page_result.total, items=[])

    async with get_async_session() as session:
        session_ids = [row.session_id for row in rows]
        metas = {meta.session_id: meta for meta in (await session.exec(
            select(AgentSessionMeta).where(AgentSessionMeta.session_id.in_(session_ids))
        )).all()}
        message_counts = dict((await session.execute(
            select(
                agent_messages.c.session_id,
                func.count(agent_messages.c.id),
            )
            .where(agent_messages.c.session_id.in_(session_ids))
            .group_by(agent_messages.c.session_id)
        )).all())

    return Page(
        page=page,
        size=size,
        total=page_result.total,
        items=[
            _summary_from_row(
                row,
                metas.get(row.session_id),
                message_count=int(message_counts.get(row.session_id, 0)),
            )
            for row in rows
        ],
    )


async def _session_summary_by_id(session_id: str) -> AgentSessionSummarySchema | None:
    stmt = _session_summary_statement().where(
        agent_sessions.c.session_id == session_id,
        AgentSessionMeta.is_deleting.is_(False),
    )
    async with get_async_session() as session:
        row = (await session.execute(stmt)).first()
        if row is None:
            return None
        meta = await session.get(AgentSessionMeta, session_id)
    return _summary_from_row(row, meta)


def _session_summary_statement():
    meta_table = AgentSessionMeta.__table__
    source = agent_sessions.join(
        meta_table,
        agent_sessions.c.session_id == meta_table.c.session_id,
    ).outerjoin(
        agent_messages,
        agent_sessions.c.session_id == agent_messages.c.session_id,
    )
    return (
        select(
            agent_sessions.c.session_id,
            agent_sessions.c.created_at,
            agent_sessions.c.updated_at,
            func.count(agent_messages.c.id).label("message_count"),
        )
        .select_from(source)
        .group_by(
            agent_sessions.c.session_id,
            agent_sessions.c.created_at,
            agent_sessions.c.updated_at,
        )
    )


def _session_list_statement():
    return (
        select(
            agent_sessions.c.session_id,
            agent_sessions.c.created_at,
            agent_sessions.c.updated_at,
        )
        .select_from(
            agent_sessions.join(
                AgentSessionMeta.__table__,
                agent_sessions.c.session_id == AgentSessionMeta.__table__.c.session_id,
            )
        )
    )


def _summary_from_row(
    row,
    meta: AgentSessionMeta | None,
    *,
    message_count: int | None = None,
) -> AgentSessionSummarySchema:
    session_type = meta.session_type if meta else SessionType.CHAT
    return AgentSessionSummarySchema(
        session_id=row.session_id,
        session_type=session_type,
        title=_resolve_title(meta),
        agent_code=meta.agent_code if meta else "",
        owner_id=meta.owner_id if meta else 0,
        project_id=meta.project_id if meta else None,
        selected_sandbox_container_id=meta.selected_sandbox_container_id if meta else None,
        selected_sandbox_container_generation=meta.selected_sandbox_container_generation if meta else 0,
        is_running=meta.is_running if meta else False,
        runtime_agent_code=meta.runtime_agent_code if meta else "",
        runtime_sandbox_container_id=meta.runtime_sandbox_container_id if meta else None,
        runtime_sandbox_container_generation=meta.runtime_sandbox_container_generation if meta else 0,
        run_started_at=meta.run_started_at if meta else None,
        run_finished_at=meta.run_finished_at if meta else None,
        run_error=meta.run_error if meta else "",
        message_count=(
            message_count
            if message_count is not None
            else int(getattr(row, "message_count", 0) or 0)
        ),
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


async def update_session_sandbox_container(
    session_id: str,
    *,
    sandbox_container_id: int | None,
    sandbox_container_generation: int,
    user_id: int,
    user_role: SystemUserRole,
) -> AgentSessionSummarySchema | None:
    async with get_async_session() as session:
        meta = await session.get(AgentSessionMeta, session_id)
        if meta is None or not await _can_access_meta(session, meta, user_id, user_role):
            return None
        meta.selected_sandbox_container_id = sandbox_container_id
        meta.selected_sandbox_container_generation = sandbox_container_generation
        session.add(meta)
        await session.commit()
    return await session_summary(session_id, user_id=user_id, user_role=user_role)


async def load_session_timeline(
    session_id: str,
    user_id: int,
    user_role: SystemUserRole,
) -> tuple[list[AgentTimelineItemSchema], bool, int | None] | None:
    return await load_session_timeline_page(
        session_id=session_id,
        user_id=user_id,
        user_role=user_role,
        before_sequence=None,
        limit=DEFAULT_TIMELINE_PAGE_SIZE,
    )


async def load_session_timeline_page(
    session_id: str,
    user_id: int,
    user_role: SystemUserRole,
    *,
    before_sequence: int | None,
    limit: int,
) -> tuple[list[AgentTimelineItemSchema], bool, int | None] | None:
    """Return one turn-aligned page of revisioned timeline items."""
    async with get_async_session() as session:
        if not await _can_access_session(session, session_id, user_id, user_role):
            return None

    await get_agent_pool().flush_timeline(session_id)

    return await fetch_timeline_page(
        session_id,
        before_sequence=before_sequence,
        limit=max(1, limit),
    )


async def can_access_session(session_id: str, user_id: int, user_role: SystemUserRole) -> bool:
    async with get_async_session() as session:
        return await _can_access_session(session, session_id, user_id, user_role)


async def get_accessible_session_meta(
    session_id: str,
    user_id: int,
    user_role: SystemUserRole,
) -> AgentSessionMeta | None:
    async with get_async_session() as session:
        meta = await session.get(AgentSessionMeta, session_id)
        if meta is None or not await _can_access_meta(session, meta, user_id, user_role):
            return None
        return meta


async def project_id_for_session(session_id: str) -> int | None:
    meta = await get_session_meta(session_id)
    return meta.project_id if meta is not None else None


async def delete_session(
    session_id: str,
    user_id: int = 0,
    user_role: SystemUserRole = SystemUserRole.USER,
    *,
    allow_project_session: bool = False,
) -> bool:
    if not session_id:
        return False

    async with get_async_session() as session:
        meta = (await session.exec(
            select(AgentSessionMeta)
            .where(AgentSessionMeta.session_id == session_id)
            .with_for_update()
        )).first()
        if (
            meta is None
            or meta.is_deleting
            or not await _can_manage_meta(session, meta, user_id, user_role)
        ):
            return False
        if meta.project_id is not None and not allow_project_session:
            return False
        meta.is_deleting = True
        session.add(meta)
        await session.commit()

    try:
        await _teardown_session_runtime(session_id)
    except BaseException:
        try:
            async with get_async_session() as session:
                meta = await session.get(AgentSessionMeta, session_id)
                if meta is not None:
                    meta.is_deleting = False
                    session.add(meta)
                    await session.commit()
        except Exception:
            logger.exception("failed to restore agent session deletion state: %s", session_id)
        raise

    async with get_async_session() as session:
        meta = (await session.exec(
            select(AgentSessionMeta)
            .where(AgentSessionMeta.session_id == session_id)
            .with_for_update()
        )).first()
        if meta is None or not await _can_manage_meta(session, meta, user_id, user_role):
            return False
        if meta.project_id is not None and not allow_project_session:
            return False
        records_deleted = await _delete_session_records_in_tx(session, session_id)
        await session.commit()

    if records_deleted:
        logger.info("agent session deleted: %s", session_id)
    return records_deleted


async def delete_private_sessions_for_owner(owner_id: int) -> int:
    """Delete every non-project conversation owned by a removed user."""
    async with get_async_session() as session:
        session_ids = list((await session.exec(
            select(AgentSessionMeta.session_id).where(
                AgentSessionMeta.owner_id == owner_id,
                AgentSessionMeta.project_id.is_(None),
            )
        )).all())
    if not session_ids:
        return 0

    async with get_async_session() as session:
        await session.execute(
            update(AgentSessionMeta)
            .where(AgentSessionMeta.session_id.in_(session_ids))
            .values(is_deleting=True)
        )
        await session.commit()

    for offset in range(0, len(session_ids), _SESSION_TEARDOWN_BATCH_SIZE):
        await asyncio.gather(*(
            _teardown_session_runtime(session_id)
            for session_id in session_ids[offset:offset + _SESSION_TEARDOWN_BATCH_SIZE]
        ))
    async with get_async_session() as session:
        result = await session.execute(
            delete(agent_sessions).where(agent_sessions.c.session_id.in_(session_ids))
        )
        await session.commit()
    deleted = result.rowcount or 0
    logger.info("private agent sessions deleted for user: user=%s sessions=%s", owner_id, deleted)
    return deleted


async def _teardown_session_runtime(session_id: str) -> None:
    await get_agent_pool().discard(session_id)


async def cancel_sessions(session_ids: list[str], reason: str) -> None:
    for session_id in session_ids:
        await get_agent_pool().cancel_all(session_id)
    await mark_sessions_stopped(session_ids, error=reason)


async def _delete_session_records_in_tx(session: AsyncSession, session_id: str) -> bool:
    # one DELETE drops the SDK session row and the FK CASCADE chain takes
    # care of agent_messages, agent_message_meta, and agent_session_meta
    result = await session.execute(
        delete(agent_sessions).where(agent_sessions.c.session_id == session_id)
    )
    return (result.rowcount or 0) > 0


async def ensure_sdk_session_row(session: AsyncSession, session_id: str) -> None:
    # placeholder row owned by the SDK; required so AgentSessionMeta's FK can
    # bind and so list_sessions can surface freshly-created empty conversations
    await session.execute(
        text(
            "INSERT INTO agent_sessions (session_id) VALUES (:sid) "
            "ON CONFLICT (session_id) DO NOTHING"
        ),
        {"sid": session_id},
    )


async def _can_access_session(
    session: AsyncSession,
    session_id: str,
    user_id: int,
    user_role: SystemUserRole,
) -> bool:
    meta = await session.get(AgentSessionMeta, session_id)
    return meta is not None and await _can_access_meta(session, meta, user_id, user_role)


async def _can_access_meta(
    session: AsyncSession,
    meta: AgentSessionMeta,
    user_id: int,
    user_role: SystemUserRole,
) -> bool:
    if meta.is_deleting:
        return False
    return await _can_manage_meta(session, meta, user_id, user_role)


async def _can_manage_meta(
    session: AsyncSession,
    meta: AgentSessionMeta,
    user_id: int,
    user_role: SystemUserRole,
) -> bool:
    if meta.project_id is None:
        return meta.owner_id == user_id
    if await session.get(WorkProject, meta.project_id) is None:
        return False
    if user_role == SystemUserRole.ADMIN:
        return True
    return await session.get(WorkProjectOwner, (meta.project_id, user_id)) is not None


def _resolve_title(meta: AgentSessionMeta | None) -> str:
    if meta is None:
        return ""
    return meta.title or ("Project session" if meta.session_type == SessionType.PROJECT else "Untitled session")


def _truncate(value: str) -> str:
    value = value.strip().replace("\n", " ")
    return value if len(value) <= _TITLE_MAX_LEN else value[: _TITLE_MAX_LEN - 1] + "..."
