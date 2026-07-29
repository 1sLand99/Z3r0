"""Transactional completion gate for work projects."""

from datetime import datetime

from sqlmodel import select

from database import get_async_session
from model.work_project.assets import WorkProjectAsset
from model.work_project.findings import WorkProjectFinding
from model.work_project.graph import WorkProjectAttackPath, WorkProjectAttackPathStep
from model.work_project.projects import WorkProject
from model.work_project.workflow import WorkProjectWorkItem, WorkProjectWorkItemTarget
from schema.work_project.assets import WorkProjectAssetScope
from schema.work_project.findings import WorkProjectFindingVerification
from schema.work_project.graph import (
    WorkProjectAttackPathStatus,
    WorkProjectAttackPathStepSchema,
    derive_attack_path_status,
)
from schema.work_project.projects import WorkProjectStatus
from schema.work_project.workflow import WorkProjectTargetStatus, WorkProjectWorkItemStatus


async def complete_work_project(project_id: int) -> str:
    async with get_async_session() as session:
        project = (await session.exec(
            select(WorkProject).where(WorkProject.id == project_id).with_for_update()
        )).one_or_none()
        if project is None:
            return "work project not found"
        if project.status != WorkProjectStatus.ACTIVE:
            return f"work project is {project.status}"

        open_work = (await session.exec(
            select(WorkProjectWorkItem.id)
            .where(
                WorkProjectWorkItem.project_id == project_id,
                WorkProjectWorkItem.status.not_in({
                    WorkProjectWorkItemStatus.COMPLETED,
                    WorkProjectWorkItemStatus.CANCELED,
                }),
            )
            .limit(1)
        )).first()
        if open_work is not None:
            return "work project has non-terminal work items"

        suspected = (await session.exec(
            select(WorkProjectFinding.id)
            .where(
                WorkProjectFinding.project_id == project_id,
                WorkProjectFinding.verification == WorkProjectFindingVerification.SUSPECTED,
            )
            .limit(1)
        )).first()
        if suspected is not None:
            return "work project has suspected findings that require validation, refutation, or deferral"

        in_scope_assets = set((await session.exec(
            select(WorkProjectAsset.id).where(
                WorkProjectAsset.project_id == project_id,
                WorkProjectAsset.scope == WorkProjectAssetScope.IN_SCOPE,
            )
        )).all())
        covered_assets = set((await session.exec(
            select(WorkProjectWorkItemTarget.asset_id)
            .join(WorkProjectWorkItem, WorkProjectWorkItem.id == WorkProjectWorkItemTarget.work_item_id)
            .where(
                WorkProjectWorkItem.project_id == project_id,
                WorkProjectWorkItem.status == WorkProjectWorkItemStatus.COMPLETED,
                WorkProjectWorkItemTarget.status.in_({
                    WorkProjectTargetStatus.COVERED,
                    WorkProjectTargetStatus.DEFERRED,
                }),
            )
        )).all())
        if not in_scope_assets.issubset(covered_assets):
            return "work project has in-scope assets without a covered or deferred target conclusion"

        paths = list((await session.exec(
            select(WorkProjectAttackPath).where(WorkProjectAttackPath.project_id == project_id)
        )).all())
        steps = list((await session.exec(
            select(WorkProjectAttackPathStep).where(WorkProjectAttackPathStep.project_id == project_id)
        )).all())
        steps_by_path: dict[int, list[WorkProjectAttackPathStepSchema]] = {}
        for step in steps:
            steps_by_path.setdefault(step.path_id, []).append(
                WorkProjectAttackPathStepSchema.model_validate(step)
            )
        resolved_statuses = {
            WorkProjectAttackPathStatus.VALIDATED,
            WorkProjectAttackPathStatus.REFUTED,
            WorkProjectAttackPathStatus.ARCHIVED,
        }
        if any(
            derive_attack_path_status(steps_by_path.get(path.id or 0, []), path.archived_at)
            not in resolved_statuses
            for path in paths
        ):
            return "work project has unresolved attack paths"

        project.status = WorkProjectStatus.COMPLETED
        project.updated_at = datetime.now()
        session.add(project)
        await session.commit()
    return ""
