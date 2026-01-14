import csv
import io
import os
from datetime import datetime, date
from typing import Optional, List

from fastapi import FastAPI, Depends, Header, HTTPException
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from sqlalchemy import (
    create_engine, Column, Integer, String, Float, DateTime, Date, Text, Boolean
)
from sqlalchemy.orm import declarative_base, sessionmaker

db_url = os.getenv("DATABASE_URL", "sqlite:///./flatrate.db")

# Render sometimes provides postgres://; SQLAlchemy wants postgresql://
if db_url.startswith("postgres://"):
    db_url = db_url.replace("postgres://", "postgresql://", 1)

connect_args = {"check_same_thread": False} if db_url.startswith("sqlite") else {}
ENGINE = create_engine(db_url, connect_args=connect_args)
SessionLocal = sessionmaker(bind=ENGINE, autoflush=False, autocommit=False)
Base = declarative_base()

class WorkLog(Base):
    __tablename__ = "work_logs"
    id = Column(Integer, primary_key=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    is_deleted = Column(Boolean, default=False, nullable=False)
    work_date = Column(Date, nullable=False)
    category = Column(String(64), default="work", nullable=False)
    ro_number = Column(String(64), nullable=True)
    description = Column(Text, nullable=True)
    flat_hours = Column(Float, default=0.0, nullable=False)
    cash_amount = Column(Float, default=0.0, nullable=False)
    location = Column(String(128), nullable=True)

Base.metadata.create_all(bind=ENGINE)

class WorkLogIn(BaseModel):
    work_date: date
    category: str = Field(default="work", max_length=64)
    ro_number: Optional[str] = Field(default=None, max_length=64)
    description: Optional[str] = None
    flat_hours: float = 0.0
    cash_amount: float = 0.0
    location: Optional[str] = Field(default=None, max_length=128)

class WorkLogOut(WorkLogIn):
    id: int
    created_at: datetime
    updated_at: datetime
    is_deleted: bool

class BulkImport(BaseModel):
    items: List[WorkLogIn]

app = FastAPI(title="FlatRateTracker Backend", version="0.1.0")

def require_api_key(x_api_key: str | None = Header(default=None)):
    expected = os.getenv("API_KEY")
    # If API_KEY isn't set (local dev), leave it open so you don't brick yourself.
    if not expected:
        return
    if x_api_key != expected:
        raise HTTPException(status_code=401, detail="Unauthorized")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/health")
def health():
    return {"ok": True, "has_api_key": bool(os.getenv("API_KEY"))}

@app.get("/logs", response_model=List[WorkLogOut])
def list_logs(from_date: Optional[date] = None, to_date: Optional[date] = None, _: None = Depends(require_api_key)):
    db = SessionLocal()
    try:
        q = db.query(WorkLog).filter(WorkLog.is_deleted == False)
        if from_date:
            q = q.filter(WorkLog.work_date >= from_date)
        if to_date:
            q = q.filter(WorkLog.work_date <= to_date)
        rows = q.order_by(WorkLog.work_date.desc(), WorkLog.id.desc()).all()
        return [
            WorkLogOut(
                id=r.id,
                created_at=r.created_at,
                updated_at=r.updated_at,
                is_deleted=r.is_deleted,
                work_date=r.work_date,
                category=r.category,
                ro_number=r.ro_number,
                description=r.description,
                flat_hours=r.flat_hours,
                cash_amount=r.cash_amount,
                location=r.location,
            )
            for r in rows
        ]
    finally:
        db.close()

@app.post("/logs", response_model=WorkLogOut)
def create_log(item: WorkLogIn, _: None = Depends(require_api_key)):
    db = SessionLocal()
    try:
        row = WorkLog(
            work_date=item.work_date,
            category=item.category,
            ro_number=item.ro_number,
            description=item.description,
            flat_hours=item.flat_hours,
            cash_amount=item.cash_amount,
            location=item.location,
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        return WorkLogOut(
            id=row.id,
            created_at=row.created_at,
            updated_at=row.updated_at,
            is_deleted=row.is_deleted,
            work_date=row.work_date,
            category=row.category,
            ro_number=row.ro_number,
            description=row.description,
            flat_hours=row.flat_hours,
            cash_amount=row.cash_amount,
            location=row.location,
        )
    finally:
        db.close()

@app.put("/logs/{log_id}", response_model=WorkLogOut)
def update_log(log_id: int, item: WorkLogIn, _: None = Depends(require_api_key)):
    db = SessionLocal()
    try:
        row = db.query(WorkLog).filter(WorkLog.id == log_id).first()
        if not row:
            raise HTTPException(status_code=404, detail="Not found")

        row.work_date = item.work_date
        row.category = item.category
        row.ro_number = item.ro_number
        row.description = item.description
        row.flat_hours = item.flat_hours
        row.cash_amount = item.cash_amount
        row.location = item.location
        row.updated_at = datetime.utcnow()

        db.commit()
        db.refresh(row)
        return WorkLogOut(
            id=row.id,
            created_at=row.created_at,
            updated_at=row.updated_at,
            is_deleted=row.is_deleted,
            work_date=row.work_date,
            category=row.category,
            ro_number=row.ro_number,
            description=row.description,
            flat_hours=row.flat_hours,
            cash_amount=row.cash_amount,
            location=row.location,
        )
    finally:
        db.close()

@app.delete("/logs/{log_id}")
def delete_log(log_id: int, _: None = Depends(require_api_key)):
    db = SessionLocal()
    try:
        row = db.query(WorkLog).filter(WorkLog.id == log_id).first()
        if not row:
            raise HTTPException(status_code=404, detail="Not found")
        row.is_deleted = True
        row.updated_at = datetime.utcnow()
        db.commit()
        return {"deleted": True, "id": log_id, "soft": True}
    finally:
        db.close()

@app.get("/export.csv")
def export_csv(from_date: Optional[date] = None, to_date: Optional[date] = None, _: None = Depends(require_api_key)):
    db = SessionLocal()
    try:
        q = db.query(WorkLog).filter(WorkLog.is_deleted == False)
        if from_date:
            q = q.filter(WorkLog.work_date >= from_date)
        if to_date:
            q = q.filter(WorkLog.work_date <= to_date)

        rows = q.order_by(WorkLog.work_date.asc(), WorkLog.id.asc()).all()

        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["id","created_at","updated_at","work_date","category","ro_number","description","flat_hours","cash_amount","location"])
        for r in rows:
            w.writerow([
                r.id,
                r.created_at.isoformat() if r.created_at else "",
                r.updated_at.isoformat() if r.updated_at else "",
                r.work_date.isoformat() if r.work_date else "",
                r.category or "",
                r.ro_number or "",
                (r.description or "").replace("\n"," ").strip(),
                r.flat_hours,
                r.cash_amount,
                r.location or ""
            ])
        buf.seek(0)

        filename = "flatrate_export.csv"
        return StreamingResponse(
            iter([buf.getvalue()]),
            media_type="text/csv",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'}
        )
    finally:
        db.close()

@app.post("/import")
def bulk_import(payload: BulkImport, _: None = Depends(require_api_key)):
    db = SessionLocal()
    try:
        created = 0
        for item in payload.items:
            row = WorkLog(
                work_date=item.work_date,
                category=item.category,
                ro_number=item.ro_number,
                description=item.description,
                flat_hours=item.flat_hours,
                cash_amount=item.cash_amount,
                location=item.location,
            )
            db.add(row)
            created += 1
        db.commit()
        return {"imported": created}
    finally:
        db.close()
