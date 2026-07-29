from datetime import datetime

from sqlalchemy import BigInteger, Column, Index, String, Text, UniqueConstraint
from sqlmodel import Field, SQLModel


class AgentTimelineItemRecord(SQLModel, table=True):
    """Durable snapshot of one logical item in an agent session timeline."""

    __tablename__ = "agent_timeline_items"
    __table_args__ = (
        UniqueConstraint("session_id", "item_id", name="uq_agent_timeline_session_item"),
        UniqueConstraint("session_id", "sequence", name="uq_agent_timeline_session_sequence"),
        Index("ix_agent_timeline_session_sequence", "session_id", "sequence"),
        Index("ix_agent_timeline_session_type", "session_id", "item_type"),
    )

    id: int | None = Field(default=None, sa_column=Column(BigInteger, primary_key=True, autoincrement=True))
    session_id: str = Field(
        foreign_key="agent_sessions.session_id",
        ondelete="CASCADE",
        index=True,
    )
    item_id: str = Field(sa_column=Column(Text, nullable=False))
    sequence: int = Field(sa_column=Column(BigInteger, nullable=False))
    revision: int = Field(sa_column=Column(BigInteger, nullable=False))
    item_type: str = Field(sa_column=Column(String(32), nullable=False))
    parent_item_id: str | None = Field(default=None, sa_column=Column(Text, nullable=True))
    payload: str = Field(sa_column=Column(Text, nullable=False))
    created_at: datetime = Field(default_factory=datetime.now)
    updated_at: datetime = Field(default_factory=datetime.now)
