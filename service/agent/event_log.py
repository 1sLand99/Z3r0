"""Persistence and turn-aligned pagination for agent timeline items."""

import json
from datetime import datetime
from typing import Any

from pydantic import TypeAdapter
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from database import get_async_session
from logger import get_logger
from model.agent.event_log import AgentTimelineItemRecord
from schema.agent.events import (
    AgentTimelineContentStateSchema,
    AgentTimelineItemSchema,
    AgentTimelineItemTypeSchema,
    AgentTimelineToolStateSchema,
)
from schema.agent.subordinates import AgentSubordinateStatus


logger = get_logger(__name__)
_timeline_item_adapter = TypeAdapter(AgentTimelineItemSchema)
_TURN_START_TYPES = (
    AgentTimelineItemTypeSchema.USER_MESSAGE.value,
    AgentTimelineItemTypeSchema.TURN_BOUNDARY.value,
)


async def load_timeline_state(session_id: str) -> tuple[int, list[AgentTimelineItemSchema]]:
    """Load the sequence head plus only items that can still receive updates."""
    table = AgentTimelineItemRecord.__table__
    async with get_async_session() as session:
        max_sequence = int((await session.execute(
            select(func.max(table.c.sequence)).where(table.c.session_id == session_id)
        )).scalar() or 0)
        rows = (await session.execute(
            select(table.c.payload).where(
                table.c.session_id == session_id,
                table.c.item_type.in_((
                    AgentTimelineItemTypeSchema.THINKING.value,
                    AgentTimelineItemTypeSchema.TEXT.value,
                    AgentTimelineItemTypeSchema.TOOL.value,
                    AgentTimelineItemTypeSchema.SUBAGENT.value,
                )),
            )
        )).all()

    active: list[AgentTimelineItemSchema] = []
    for row in rows:
        item = _validate_payload(row.payload)
        if item is not None and _can_receive_update(item):
            active.append(item)
    return max_sequence, active


async def upsert_timeline_items(
    session_id: str,
    items: list[AgentTimelineItemSchema],
) -> None:
    if not items:
        return
    table = AgentTimelineItemRecord.__table__
    now = datetime.now()
    values = [
        {
            "session_id": session_id,
            "item_id": item.item_id,
            "sequence": item.sequence,
            "revision": item.revision,
            "item_type": str(item.type),
            "parent_item_id": item.parent_item_id,
            "payload": item.model_dump_json(),
            "created_at": item.created_at,
            "updated_at": now,
        }
        for item in items
    ]
    statement = pg_insert(table).values(values)
    statement = statement.on_conflict_do_update(
        index_elements=[table.c.session_id, table.c.item_id],
        set_={
            "revision": statement.excluded.revision,
            "item_type": statement.excluded.item_type,
            "parent_item_id": statement.excluded.parent_item_id,
            "payload": statement.excluded.payload,
            "updated_at": statement.excluded.updated_at,
        },
        where=statement.excluded.revision > table.c.revision,
    )
    async with get_async_session() as session:
        await session.execute(statement)
        await session.commit()


async def fetch_timeline_page(
    session_id: str,
    *,
    before_sequence: int | None,
    limit: int,
) -> tuple[list[AgentTimelineItemSchema], bool, int | None]:
    """Fetch one complete-turn page in ascending sequence order."""
    table = AgentTimelineItemRecord.__table__
    limit = max(1, limit)
    async with get_async_session() as session:
        latest = select(table.c.sequence, table.c.payload, table.c.item_type).where(
            table.c.session_id == session_id
        )
        if before_sequence is not None:
            latest = latest.where(table.c.sequence < before_sequence)
        latest = latest.order_by(table.c.sequence.desc()).limit(limit)
        rows = list(reversed((await session.execute(latest)).all()))
        if not rows:
            return [], False, None

        first_sequence = int(rows[0].sequence)
        if rows[0].item_type not in _TURN_START_TYPES:
            turn_start = (await session.execute(
                select(func.max(table.c.sequence)).where(
                    table.c.session_id == session_id,
                    table.c.sequence < first_sequence,
                    table.c.item_type.in_(_TURN_START_TYPES),
                )
            )).scalar()
            if turn_start is not None:
                prefix = (await session.execute(
                    select(table.c.sequence, table.c.payload, table.c.item_type)
                    .where(
                        table.c.session_id == session_id,
                        table.c.sequence >= int(turn_start),
                        table.c.sequence < first_sequence,
                    )
                    .order_by(table.c.sequence.asc())
                )).all()
                rows = [*prefix, *rows]
                first_sequence = int(rows[0].sequence)

        has_more = bool((await session.execute(
            select(table.c.sequence).where(
                table.c.session_id == session_id,
                table.c.sequence < first_sequence,
            ).limit(1)
        )).first())

    items = [item for row in rows if (item := _validate_payload(row.payload)) is not None]
    return items, has_more, first_sequence if has_more else None


def _validate_payload(payload: Any) -> AgentTimelineItemSchema | None:
    try:
        value = json.loads(payload)
        return _timeline_item_adapter.validate_python(value)
    except Exception:
        logger.debug("skipping malformed timeline item", exc_info=True)
        return None


def _can_receive_update(item: AgentTimelineItemSchema) -> bool:
    if item.type in (AgentTimelineItemTypeSchema.THINKING, AgentTimelineItemTypeSchema.TEXT):
        return item.state == AgentTimelineContentStateSchema.STREAMING
    if item.type == AgentTimelineItemTypeSchema.TOOL:
        return item.state == AgentTimelineToolStateSchema.PENDING
    if item.type == AgentTimelineItemTypeSchema.SUBAGENT:
        return item.status == AgentSubordinateStatus.RUNNING
    return False
