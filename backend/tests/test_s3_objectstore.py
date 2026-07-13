from __future__ import annotations

import io
from datetime import datetime, timezone
from unittest.mock import Mock, patch

import pytest
from botocore.exceptions import ClientError

from backend.config import Settings
from backend.services import objectstore as objectstore_module
from backend.services.objectstore import (
    InvalidKeyError,
    LocalObjectStore,
    ObjectSizeLimitExceeded,
    S3ObjectStore,
    ScopedObjectStore,
    check_object_store_ready,
    create_object_store,
)


def _client_error(code: str) -> ClientError:
    return ClientError({"Error": {"Code": code, "Message": "failed"}}, "operation")


class FakePaginator:
    def __init__(self, client: "FakeS3Client") -> None:
        self.client = client

    def paginate(self, *, Bucket: str, Prefix: str):
        matching = [
            {
                "Key": key,
                "Size": len(value),
                "LastModified": datetime(2026, 1, 1, tzinfo=timezone.utc),
            }
            for key, value in self.client.objects.items()
            if key.startswith(Prefix)
        ]
        midpoint = len(matching) // 2
        return [{"Contents": matching[:midpoint]}, {"Contents": matching[midpoint:]}]


class FakeS3Client:
    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}
        self.uploads: dict[str, list[bytes]] = {}
        self.aborted: list[str] = []
        self.calls: list[str] = []
        self.fail_upload_part = False

    def put_object(self, *, Bucket: str, Key: str, Body: bytes):
        self.calls.append("put_object")
        self.objects[Key] = bytes(Body)

    def get_object(self, *, Bucket: str, Key: str):
        self.calls.append("get_object")
        if Key not in self.objects:
            raise _client_error("NoSuchKey")
        return {"Body": io.BytesIO(self.objects[Key])}

    def delete_object(self, *, Bucket: str, Key: str):
        self.calls.append("delete_object")
        self.objects.pop(Key, None)

    def head_object(self, *, Bucket: str, Key: str):
        self.calls.append("head_object")
        if Key not in self.objects:
            raise _client_error("404")
        return {
            "ContentLength": len(self.objects[Key]),
            "LastModified": datetime(2026, 1, 1, tzinfo=timezone.utc),
        }

    def get_paginator(self, operation: str):
        assert operation == "list_objects_v2"
        return FakePaginator(self)

    def create_multipart_upload(self, *, Bucket: str, Key: str):
        self.calls.append("create_multipart_upload")
        self.uploads["upload-1"] = []
        return {"UploadId": "upload-1"}

    def upload_part(self, *, Bucket: str, Key: str, UploadId: str, PartNumber: int, Body: bytes):
        self.calls.append("upload_part")
        if self.fail_upload_part:
            raise _client_error("InternalError")
        self.uploads[UploadId].append(bytes(Body))
        return {"ETag": f"etag-{PartNumber}"}

    def complete_multipart_upload(self, *, Bucket: str, Key: str, UploadId: str, MultipartUpload):
        self.calls.append("complete_multipart_upload")
        self.objects[Key] = b"".join(self.uploads.pop(UploadId))

    def abort_multipart_upload(self, *, Bucket: str, Key: str, UploadId: str):
        self.calls.append("abort_multipart_upload")
        self.uploads.pop(UploadId, None)
        self.aborted.append(UploadId)

    def head_bucket(self, *, Bucket: str):
        self.calls.append("head_bucket")


@pytest.fixture()
def client() -> FakeS3Client:
    return FakeS3Client()


@pytest.fixture()
def store(client: FakeS3Client) -> S3ObjectStore:
    return S3ObjectStore("orrery", client)


def test_small_object_protocol_round_trip(store: S3ObjectStore) -> None:
    assert store.put("papers/a.pdf", io.BytesIO(b"abc"), max_bytes=3) == 3
    with store.open("papers/a.pdf") as stream:
        assert stream.read() == b"abc"
    assert store.stat("papers/a.pdf").size_bytes == 3  # type: ignore[union-attr]
    store.delete("papers/a.pdf")
    store.delete("papers/a.pdf")
    assert store.stat("papers/a.pdf") is None


def test_list_uses_all_pages_and_sorts(store: S3ObjectStore, client: FakeS3Client) -> None:
    client.objects = {
        "papers/z.pdf": b"z",
        "other/a.pdf": b"ignored",
        "papers/a.pdf": b"a",
    }

    assert [item.key for item in store.list("papers/")] == [
        "papers/a.pdf",
        "papers/z.pdf",
    ]


def test_scoped_store_preserves_prefix_isolation(store: S3ObjectStore) -> None:
    alice = ScopedObjectStore(store, "users/alice")
    alice_evil = ScopedObjectStore(store, "users/aliceevil")

    alice.put("papers/alpha.pdf", io.BytesIO(b"alpha"))
    alice.put("papers/beta.pdf", io.BytesIO(b"beta"))
    alice.put("papers-archive/old.pdf", io.BytesIO(b"archive"))
    alice.put("notes/a.txt", io.BytesIO(b"notes"))
    alice_evil.put("papers/alpine.pdf", io.BytesIO(b"evil"))

    assert [item.key for item in alice.list("")] == [
        "notes/a.txt",
        "papers-archive/old.pdf",
        "papers/alpha.pdf",
        "papers/beta.pdf",
    ]
    assert [item.key for item in alice.list("papers/")] == [
        "papers/alpha.pdf",
        "papers/beta.pdf",
    ]
    assert [item.key for item in alice.list("papers/al")] == ["papers/alpha.pdf"]


def test_invalid_key_is_rejected_before_sdk_call(store: S3ObjectStore, client: FakeS3Client) -> None:
    with pytest.raises(InvalidKeyError):
        store.put("../escape", io.BytesIO(b"value"))
    with pytest.raises(InvalidKeyError):
        store.list("papers/../../")
    assert client.calls == []


def test_missing_and_operational_errors_are_distinct(store: S3ObjectStore, client: FakeS3Client) -> None:
    with pytest.raises(FileNotFoundError):
        store.open("papers/missing.pdf")
    client.head_object = Mock(side_effect=_client_error("AccessDenied"))
    with pytest.raises(ClientError, match="AccessDenied"):
        store.stat("papers/private.pdf")


def test_oversized_multipart_is_aborted(store: S3ObjectStore, client: FakeS3Client) -> None:
    chunk_size = objectstore_module._MULTIPART_CHUNK_SIZE
    with pytest.raises(ObjectSizeLimitExceeded):
        store.put(
            "papers/large.pdf",
            io.BytesIO(b"x" * (chunk_size + 1)),
            max_bytes=chunk_size,
        )
    assert client.aborted == ["upload-1"]
    assert "papers/large.pdf" not in client.objects
    assert client.uploads == {}


def test_multipart_upload_completes(store: S3ObjectStore, client: FakeS3Client) -> None:
    data = b"x" * (objectstore_module._MULTIPART_CHUNK_SIZE + 1)

    assert store.put("papers/large.pdf", io.BytesIO(data)) == len(data)

    assert client.objects["papers/large.pdf"] == data
    assert client.uploads == {}


def test_multipart_sdk_failure_is_aborted(store: S3ObjectStore, client: FakeS3Client) -> None:
    client.fail_upload_part = True
    with pytest.raises(ClientError, match="InternalError"):
        store.put(
            "papers/large.pdf",
            io.BytesIO(b"x" * (objectstore_module._MULTIPART_CHUNK_SIZE + 1)),
        )
    assert client.aborted == ["upload-1"]
    assert "papers/large.pdf" not in client.objects


def test_abort_failure_warns_without_masking_original_error(
    store: S3ObjectStore, client: FakeS3Client
) -> None:
    client.abort_multipart_upload = Mock(
        side_effect=RuntimeError("credential-canary")
    )
    chunk_size = objectstore_module._MULTIPART_CHUNK_SIZE

    with patch.object(objectstore_module.logger, "warning") as warning:
        with pytest.raises(ObjectSizeLimitExceeded):
            store.put(
                "papers/large.pdf",
                io.BytesIO(b"x" * (chunk_size + 1)),
                max_bytes=chunk_size,
            )

    warning.assert_called_once_with(
        "Failed to abort incomplete S3 multipart upload; "
        "manual cleanup may be required"
    )
    assert "credential-canary" not in str(warning.call_args)


def test_factory_selects_local(tmp_path) -> None:
    configured = Settings(_env_file=None, ORRERY_DBS_DIR=tmp_path)
    assert isinstance(create_object_store(configured), LocalObjectStore)


def test_factory_builds_generic_s3_client() -> None:
    configured = Settings(
        _env_file=None,
        ORRERY_OBJECT_STORE="s3",
        ORRERY_S3_BUCKET="orrery",
        ORRERY_S3_ENDPOINT_URL="http://minio:9000",
        ORRERY_S3_REGION="us-east-1",
        ORRERY_S3_ACCESS_KEY_ID="access",
        ORRERY_S3_SECRET_ACCESS_KEY="secret",
        ORRERY_S3_ADDRESSING_STYLE="path",
    )
    with patch("backend.services.objectstore.boto3.client") as make_client:
        result = create_object_store(configured)

    assert isinstance(result, S3ObjectStore)
    _, kwargs = make_client.call_args
    assert kwargs["endpoint_url"] == "http://minio:9000"
    assert kwargs["region_name"] == "us-east-1"
    assert kwargs["aws_access_key_id"] == "access"
    assert kwargs["aws_secret_access_key"] == "secret"


def test_readiness_wraps_failure_without_credentials() -> None:
    client = FakeS3Client()
    client.head_bucket = Mock(side_effect=RuntimeError("endpoint unavailable"))
    store = S3ObjectStore("orrery", client)

    with pytest.raises(RuntimeError) as exc_info:
        check_object_store_ready(store)

    assert str(exc_info.value) == "S3 object store readiness check failed"


def test_readiness_probes_s3_bucket(store: S3ObjectStore, client: FakeS3Client) -> None:
    check_object_store_ready(store)

    assert client.calls == ["head_bucket"]
