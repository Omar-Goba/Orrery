from __future__ import annotations

import argparse
import json
from dataclasses import asdict, dataclass

from sqlmodel import Session, select

from backend.accounting import set_storage_used
from backend.auth.db import get_engine, init_db
from backend.auth.models import User
from backend.config import settings
from backend.services.objectstore import create_object_store


@dataclass(frozen=True)
class StorageDrift:
    user_id: str
    handle: str
    recorded_bytes: int
    actual_bytes: int

    @property
    def drift_bytes(self) -> int:
        return self.actual_bytes - self.recorded_bytes


def reconcile_storage(*, fix: bool = False) -> list[StorageDrift]:
    init_db()
    objects = create_object_store(settings)
    results: list[StorageDrift] = []

    with Session(get_engine()) as db:
        users = db.exec(select(User).order_by(User.handle)).all()

    for user in users:
        prefix = f"users/{user.id}/papers/"
        actual = sum(stat.size_bytes for stat in objects.list(prefix))
        drift = StorageDrift(
            user_id=user.id,
            handle=user.handle,
            recorded_bytes=user.storage_used_bytes,
            actual_bytes=actual,
        )
        results.append(drift)
        if fix and drift.drift_bytes != 0:
            set_storage_used(user.id, actual)

    return results


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Compare User.storage_used_bytes to raw PDF bytes in ObjectStore."
    )
    parser.add_argument("--fix", action="store_true", help="update counters to match objects")
    args = parser.parse_args()

    rows = reconcile_storage(fix=args.fix)
    payload = [asdict(row) | {"drift_bytes": row.drift_bytes} for row in rows]
    print(json.dumps(payload, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
