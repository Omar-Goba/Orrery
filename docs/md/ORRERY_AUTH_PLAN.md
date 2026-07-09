# Orrery — Backend Auth Plan (Tier 2: real universes)

This is the Tier 2 counterpart to [ORRERY_UI_PLAN.md](ORRERY_UI_PLAN.md). Tier 1 shipped the
theater — fake auth, observer gating that is "cosmetic until real auth lands." This plan makes
it real: multi-user identity, roles, per-user galaxies, **authorization on the actual PDF
bytes**, storage accounting, and a storage abstraction that makes the future MinIO container a
config change instead of a third refactor.

The Tier 1 promise we must keep (UI plan §12): *"`auth/session.ts` is the only file whose
interface changes (real login call); the scene machine, gating via `mode`, and all visuals
carry over unchanged."* Everything below is designed so that stays true.

---

## 0. Roles and vocabulary

Two roles. The space vocabulary continues:

| Role | DB value | Who | One-liner |
|---|---|---|---|
| **Keeper** | `keeper` | Omar, exactly one | Keeper of the Orrery. Full owner of their own galaxy, plus a *storage lens* over every other galaxy — file names, sizes, quotas. **Nothing more, nothing less.** |
| **Voyager** | `voyager` | Everyone who signs up | Full owner of their own galaxy (add / remove / re-status PDFs, chat, reindex). Can also *tour* the Keeper's galaxy read-only. |

Naming notes:

- **"Observer" stays a mode, not a role.** A Voyager touring the Keeper's galaxy is in
  observer mode; an anonymous visitor on the landing page is too. Don't conflate the axis
  "who are you" (role) with "whose galaxy are you looking at" (mode) — Tier 1 already got
  this right with the derived `GalaxyMode`.
- Code must reference roles through constants (`ROLE_KEEPER`, `ROLE_VOYAGER`), never string
  literals, so a rename is a two-line diff. Alternate pairs if Keeper/Voyager doesn't stick:
  *Astronomer / Stargazer*, *Architect / Wanderer*, *Overseer / Traveler*. (Avoid "Curator" —
  `CuratorAgent` already owns that word in [backend/agents/curator.py](../../backend/agents/curator.py).)

### 0.1 Decisions taken (defaults you can veto)

These were judgment calls; each is a small, isolated change if you want it the other way:

1. **Sessions are opaque tokens in HTTP-only cookies, not JWTs.** Reason: the frontend uses
   `EventSource` for SSE progress ([main.py:237](../../backend/main.py)) and renders PDFs via
   browser-native fetches — neither can set an `Authorization` header. Cookies flow through
   both for free, and server-side sessions are trivially revocable.
2. **The Keeper's storage lens is metadata-only by default** (filename, bytes, upload date,
   count, quota). Opening a Voyager's actual PDF is implemented but behind
   `ORRERY_KEEPER_CAN_OPEN_FILES=false` — flip it when you have a moderation reason. This is
   the most literal reading of "nothing more, nothing less"; the flag exists because
   moderation eventually needs eyes on content.
3. **The tour is anonymous** — no login required to visit the Keeper's galaxy, matching Tier 1's
   one-click "Visit as observer." Tour chat (Oracle over your corpus) is enabled but
   rate-limited, because it costs real LLM tokens per anonymous stranger.
4. **The Keeper cannot delete or modify Voyager files.** Storage *lens*, not storage *hand*.
   Quota adjustment is the one write the Keeper gets, because quota regulation was called out
   as key. A future `ORRERY_KEEPER_CAN_DELETE` flag is the escape hatch if abuse shows up.
5. **MinIO does not ship in this tier.** The `ObjectStore` interface does, with S3-shaped keys
   from day one, so the swap later is config + `mc mirror`. Full reasoning in §10.

---

## 1. Current state (the holes we're closing)

Verified in code:

- **Zero auth.** Every endpoint in [backend/main.py](../../backend/main.py) is open. Anyone on
  the network can list papers, download any PDF (`GET /api/papers/{id}/file`, main.py:89),
  upload, reindex, or burn LLM tokens via `/api/chat`.
- **One global store.** `paper_store` ([backend/store.py](../../backend/store.py)) is a single
  in-memory dict persisted to `dbs/papers.json`. No concept of an owner anywhere in
  `PaperRecord` ([backend/models.py](../../backend/models.py)).
- **One global vector store.** Two Chroma collections (`paper_chunks`, `paper_vectors`) in
  [backend/services/vectorstore.py](../../backend/services/vectorstore.py) hold everyone-who-
  would-exist's embeddings together.
- **PDFs are filesystem paths.** Real files live in `dbs/input/`; `paper_id` is a hash of the
  *resolved path* (`paper_id_for`, store.py:12); the file endpoint's only guard is
  "path resolves inside `input/`" — correct against traversal, useless for ownership.
- **The cluster tree is a symlink forest.** `FilesystemService.rebuild_tree`
  ([backend/services/filesystem.py:17](../../backend/services/filesystem.py)) materializes
  `dbs/output/` as directories of symlinks pointing at `input/`. This is single-user,
  local-disk thinking and is **fundamentally incompatible with object storage** — symlinks
  don't exist in S3/MinIO. §10 kills it.
- **No delete.** There is no `DELETE /api/papers/{id}` today; "remove pdfs" is a new endpoint,
  not just a gated one.
- **Upload trusts the filename.** `dest = input_dir / safe_name` (main.py:179) silently
  overwrites a same-named file. In multi-user land that's a cross-user clobber if we don't
  namespace, and a self-clobber even if we do. Fixed by keying on content hash (§4.3).
- Agents (`Oracle`, `Librarian`, `Status`, `Master`, `Curator`) are module-lifetime singletons
  wired to the global stores in `lifespan` (main.py:51). They need per-user contexts (§4.4).

---

## 2. The permission matrix (the whole spec in one table)

Every row below becomes a test in §13. If an endpoint isn't in this table, it doesn't ship.

| Capability | Anonymous | Voyager → own galaxy | Voyager → Keeper's galaxy (tour) | Keeper → own galaxy | Keeper → Voyager galaxies |
|---|---|---|---|---|---|
| Sign up / log in | ✅ | — | — | — | — |
| List papers / tree / similarity | ❌ | ✅ | ✅ (tour routes) | ✅ | ❌ |
| Open PDF bytes | ❌ | ✅ own only | ✅ Keeper's only | ✅ own only | 🚩 flag, default ❌ |
| Upload PDF | ❌ | ✅ (quota-checked) | ❌ | ✅ | ❌ |
| Delete PDF | ❌ | ✅ own only | ❌ | ✅ own only | ❌ |
| Update read status | ❌ | ✅ own only | ❌ | ✅ own only | ❌ |
| Chat (Oracle/Master) | ❌ | ✅ own corpus | ✅ Keeper corpus, rate-limited | ✅ | ❌ |
| Recommendations / reindex | ❌ | ✅ own | ❌ | ✅ own | ❌ |
| Storage lens (names, sizes, dates, totals) | ❌ | own usage only (`/auth/me`) | — | own | ✅ all |
| Adjust quotas | ❌ | ❌ | ❌ | — | ✅ |
| See Voyager statuses, summaries, clusters, chat | ❌ | ❌ | ❌ | — | **❌ — this is the "nothing more" line** |
| Tour a Voyager's galaxy | ❌ | ❌ | ❌ | ❌ | ❌ — only the Keeper's galaxy is tourable |

Two structural notes:

- **Ownership is enforced by namespace, not by row filters.** Each user's papers live in their
  own store and their own Chroma collections (§4). A request scoped to user A *physically
  cannot* return user B's records — there is no query that could accidentally forget a
  `WHERE owner_id =`. Object-level checks on the PDF endpoint exist *on top of* this
  (defense in depth, §6), not instead of it.
- The tour is a distinct route namespace (`/api/tour/*`, §7), not a parameter on the normal
  routes. A `galaxy=omar` query param on `/api/papers` is exactly the kind of thing that gets
  forgotten in one handler and becomes a data leak.

---

## 3. Identity: users, passwords, sessions

### 3.1 New dependency set

`argon2-cffi` (password hashing — not passlib, it's unmaintained), `sqlmodel` (users/sessions
tables; pydantic-native so it matches the codebase), `slowapi` or a ~30-line in-house token
bucket (rate limits). Nothing else. No OAuth, no email verification in this tier.

### 3.2 Schema (`dbs/orrery.db`, SQLite)

```python
# backend/auth/models.py
class User(SQLModel, table=True):
    id: str = Field(primary_key=True)          # short uuid4 hex — NOT the handle
    handle: str = Field(unique=True, index=True)  # lowercase, ^[a-z0-9][a-z0-9._-]{2,23}$
    display_name: str
    password_hash: str                          # argon2id
    role: str = ROLE_VOYAGER                    # "keeper" | "voyager"
    storage_quota_bytes: int = DEFAULT_QUOTA    # env ORRERY_DEFAULT_QUOTA, default 500 MiB
    storage_used_bytes: int = 0                 # maintained by §9, reconciled offline
    created_at: datetime
    disabled: bool = False

class AuthSession(SQLModel, table=True):
    token_hash: str = Field(primary_key=True)   # sha256 of the cookie token
    user_id: str = Field(index=True, foreign_key="user.id")
    created_at: datetime
    expires_at: datetime                        # 30 days sliding
    last_seen_at: datetime
```

- `user_id` is opaque and permanent; `handle` is display/login only. All storage paths, Chroma
  collection names, and object keys use `user_id`, so a future handle-rename touches one row.
- Session cookie: `orrery_session`, `HttpOnly`, `SameSite=Lax`, `Secure` in prod, value is a
  256-bit random token. Only its hash is stored — a leaked DB doesn't yield live sessions.
- Papers stay in per-user `papers.json` files (§4.1), *not* in SQLite. `PaperStore` already
  does everything needed; moving it to SQL is churn with no payoff in this tier.

### 3.3 Endpoints

```
POST /api/auth/signup   {handle, display_name?, password}   → 201, sets cookie
POST /api/auth/login    {handle, password}                  → 200, sets cookie
POST /api/auth/logout                                       → 204, deletes session row + cookie
GET  /api/auth/me       → { handle, display_name, role, storage_used_bytes,
                            storage_quota_bytes, created_at }
```

Signup rules:

- Password ≥ 10 chars; hash with argon2id defaults.
- Reserved handles rejected: `admin`, `keeper`, `voyager`, `tour`, `api`, `orrery`, `omar`
  (unless it's the migration creating the Keeper), and anything in the fake-galaxy list from
  Tier 1 (`m.chen`, `vega-7`) so the landing-page fakes never collide with real people.
- `ORRERY_SIGNUP_MODE = open | invite | closed` (default `invite`): `invite` requires an
  `invite_code` field matching env `ORRERY_INVITE_CODE`. This is a self-hosted box on the
  public internet eventually — open signup on day one means strangers uploading PDFs into
  your disk and burning your OpenAI key via chat. Flip to `open` deliberately, not by default.
- Rate limits: 5/min/IP on login (credential stuffing), 3/hour/IP on signup.
- Login response and error text are identical for "no such user" and "wrong password."

### 3.4 Request dependencies (FastAPI)

```python
# backend/auth/deps.py
async def current_user(request: Request) -> User: ...      # 401 if no valid session
async def require_keeper(user = Depends(current_user)) -> User:
    if user.role != ROLE_KEEPER: raise HTTPException(403)
    return user
```

Every existing endpoint gains `user: User = Depends(current_user)` — there is no
"authenticated but unscoped" state. CSRF: `SameSite=Lax` blocks cross-site POSTs from
browsers; belt-and-suspenders, mutating handlers verify the `Origin` header against
`settings.cors_origins_list` when present. No token dance needed for a same-site SPA.

---

## 4. Per-user galaxies: namespacing every store

### 4.1 Disk layout

```
dbs/
  orrery.db                         users + sessions
  chroma/                           one client, per-user collections (§4.2)
  users/
    {user_id}/
      papers.json                   PaperStore, per user
      objects/                      ← ObjectStore-managed (§10); PDFs live here
        papers/{paper_id}.pdf
      ocr_cache/                    derived, rebuildable, excluded from quota
```

`dbs/output/` (the symlink tree) **is deleted as a concept** — see §10.2. `dbs/input/` becomes
the Keeper's `users/{keeper_id}/objects/papers/` during migration (§11).

### 4.2 Chroma: per-user collections

Collections `u{user_id}_chunks` and `u{user_id}_papers`, same cosine metadata as today.
Chosen over a shared collection with `user_id` metadata filters because a forgotten
`where={"user_id": ...}` in any future query is a silent cross-user leak; a wrong collection
name is a loud empty result. `VectorStore` becomes a thin per-user facade over the shared
`chromadb.PersistentClient`:

```python
class VectorStore:
    def __init__(self, client: chromadb.PersistentClient, user_id: str) -> None:
        self._chunks = client.get_or_create_collection(f"u{user_id}_chunks", metadata=COSINE_META)
        self._papers = client.get_or_create_collection(f"u{user_id}_papers", metadata=COSINE_META)
    # every method below this line is unchanged from today
```

### 4.3 Paper identity

`paper_id_for` (hash of resolved path) dies with the path-centric world. New:

```python
paper_id = sha256(file_bytes).hexdigest()[:16]   # computed while streaming the upload
```

Content-addressed IDs give us: duplicate detection per user (re-uploading the same PDF is a
409 with the existing record, not a silent overwrite — fixes the clobber bug in §1), stable
IDs across storage backends, and object keys that never collide. Uniqueness scope is per-user
(two users uploading the same paper each get their own copy under their own prefix; global
dedup is a Tier 3 storage optimization, noted in §14).

### 4.4 `UserSpace`: the per-request context

The `lifespan` singletons split into two groups:

- **Global, model-heavy, user-agnostic:** `OCRService`, `EmbeddingService`, the Chroma client,
  the `ObjectStore`. Constructed once in `lifespan` as today.
- **Per-user, cheap, stateless-ish:** `PaperStore`, `VectorStore` facade, `FilesystemService`
  replacement (`TreeBuilder`, §10.2), and the agents.

```python
# backend/space.py
@dataclass
class UserSpace:
    user_id: str
    papers: PaperStore          # loaded from users/{id}/papers.json
    vstore: VectorStore         # facade over shared client
    objects: ScopedObjectStore  # prefix-locked to users/{id}/ (§6)
    oracle: OracleAgent
    librarian: LibrarianAgent
    status_agent: StatusAgent
    master: MasterAgent
    curator: CuratorAgent

class SpaceRegistry:
    """LRU cache of live UserSpaces; one per user, built on first request."""
    def get(self, user_id: str) -> UserSpace: ...
```

A FastAPI dependency `space = Depends(current_space)` resolves `current_user` → registry →
`UserSpace`. Handlers change from `paper_store.all()` to `space.papers.all()` — mechanical.
The module-global `paper_store` singleton in store.py is deleted; `PaperStore` gains a
constructor path argument (it already has `load`/`save`, they just read `settings.papers_json`
— parameterize that).

Concurrency note: `papers.json` writes were single-user-safe; now serialize `save()` per
UserSpace with an `asyncio.Lock` inside `PaperStore`. Good enough for tens of users; SQLite
migration is the escape hatch if that assumption breaks.

---

## 5. Endpoint map (old → new)

All existing routes keep their paths — the frontend keeps working — they just gain auth and
lose global state:

| Route | Change |
|---|---|
| `GET /api/papers` | `Depends(current_space)`; returns *your* papers |
| `GET /api/papers/{id}/file` | full authz treatment, see §6 |
| `PATCH /api/papers/{id}/status` | scoped to space; 404 if the id isn't yours (404, not 403 — don't confirm existence) |
| `POST /api/papers/upload` | scoped; quota gate (§9); content-hash id (§4.3); writes via ObjectStore |
| `DELETE /api/papers/{id}` | **new**: removes record, object bytes, Chroma vectors+chunks (`delete_paper` already exists in vectorstore.py:131), decrements usage. Returns 204 |
| `GET /api/papers/upload/{job}/progress` | job registry entries carry `user_id`; 404 on mismatch |
| `GET /api/tree` | virtual tree from records (§10.2), scoped |
| `GET /api/similarity`, `/api/recommendations` | scoped |
| `POST /api/chat`, `POST /api/reindex` | scoped; reindex rate-limited to 1 concurrent per user |
| `POST /api/auth/*`, `GET /api/auth/me` | **new** (§3.3) |
| `GET/POST /api/tour/*` | **new** (§7) |
| `GET/PATCH /api/keeper/*` | **new** (§8) |

---

## 6. PDF authorization (the critical bit)

The PDF bytes are the crown jewels — everything else (titles, clusters) is derived metadata.
Three layers, all of which must hold independently:

1. **Route scoping.** `GET /api/papers/{id}/file` looks up `id` in `space.papers` — a paper
   you don't own is a 404 before any I/O. Tour access to the Keeper's files goes through
   `/api/tour/papers/{id}/file` which is hard-wired to the Keeper's space (§7). Keeper access
   to Voyager files goes through `/api/keeper/...` behind the §0.1 flag. There is no route
   where a user-supplied identifier selects *whose* storage is read.

2. **`ScopedObjectStore`.** Handlers never touch the raw `ObjectStore`; `UserSpace.objects`
   is a wrapper constructed with prefix `users/{user_id}/` that validates and prepends it:

   ```python
   class ScopedObjectStore:
       def __init__(self, inner: ObjectStore, prefix: str) -> None: ...
       def _key(self, rel: str) -> str:
           key = posixpath.normpath(f"{self._prefix}/{rel}")
           if not key.startswith(self._prefix) or ".." in rel:
               raise PermissionError(rel)
           return key
   ```

   Even a buggy handler holding a hostile `record.original_path` cannot escape its prefix.
   (This replaces today's `path.relative_to(input_dir)` check at main.py:96 and keeps its
   spirit.)

3. **No direct-path serving.** `FileResponse(record.original_path)` is replaced by streaming
   through the store (`StreamingResponse(space.objects.open(f"papers/{id}.pdf"), ...)`), which
   also happens to be exactly the shape MinIO needs later. `original_path` in `PaperRecord`
   is deprecated to a display-only `source_filename`.

Non-negotiable test (§13): user A, holding a valid session and a valid paper id belonging to
user B, gets 404 from every route that can emit PDF bytes. This test is written *before* the
endpoints are refactored.

---

## 7. The tour (`/api/tour/*`)

The Keeper's galaxy is the only public one. Implemented as its own router whose space is
resolved server-side — never from client input:

```python
def tour_space() -> UserSpace:
    return registry.get(keeper_user_id())   # single user with role == "keeper"
```

```
GET  /api/tour/galaxy                → { display_name, stars, ignited, constellations }  (plaque data)
GET  /api/tour/papers                → Keeper's PaperRecords
GET  /api/tour/tree                  → Keeper's virtual tree
GET  /api/tour/similarity            → Keeper's neighbor map
GET  /api/tour/papers/{id}/file      → Keeper's PDF bytes (read-only)
POST /api/tour/chat                  → Oracle over Keeper's corpus — rate-limited 10 msg/hour/IP
```

- No auth required (Tier 1's one-click observer promise). All handlers are read-only by
  construction; the router simply has no mutating routes.
- **No** `/api/tour/recommendations` — ReadNext is a personal queue and Tier 1 already hides
  it in observer mode.
- Tour chat is the one endpoint where anonymous traffic spends your LLM money. The rate limit
  is per-IP; `ORRERY_TOUR_CHAT=off` exists for the day it's abused.
- Frontend: observer mode swaps its API base from `/api/` to `/api/tour/` — one conditional in
  `api/client.ts`, mode-derived, matching the Tier 1 gating seam.
- Voyager galaxies are not tourable, period. There is no `is_public` flag, no
  `/api/tour/{handle}/...`. When "open your galaxy to visitors" becomes a real feature it's a
  deliberate Tier 3 project (§14), not a latent codepath.

---

## 8. The Keeper's storage lens (`/api/keeper/*`)

All routes `Depends(require_keeper)`. The response models are the enforcement mechanism for
"nothing more, nothing less" — the lens *cannot* leak reading status or summaries because the
Pydantic models don't have those fields:

```python
class VoyagerStorageSummary(BaseModel):
    handle: str
    display_name: str
    created_at: datetime
    paper_count: int
    storage_used_bytes: int
    storage_quota_bytes: int
    disabled: bool

class StoredFileEntry(BaseModel):
    paper_id: str
    filename: str            # original upload name
    size_bytes: int
    uploaded_at: datetime
    # deliberately absent: status, title, summary, cluster_path, author, year
```

```
GET   /api/keeper/voyagers                       → list[VoyagerStorageSummary]
GET   /api/keeper/voyagers/{handle}/files        → list[StoredFileEntry]
PATCH /api/keeper/voyagers/{handle}/quota        {storage_quota_bytes} → summary
GET   /api/keeper/voyagers/{handle}/files/{paper_id}/raw
      → PDF bytes; 403 unless ORRERY_KEEPER_CAN_OPEN_FILES=true (§0.1 decision 2)
```

The Keeper's own galaxy uses the normal `/api/*` routes like any user — keeper-ness adds the
lens, it doesn't change how you use your own galaxy. Frontend gets a new glass panel
("Storage Ledger") visible only when `me.role == "keeper"`, listing voyagers with usage bars;
it is a metadata table, *not* a galaxy visualization of their data — matching the permission,
the UI shows storage, nothing more.

---

## 9. Storage accounting and quotas

This is load-bearing for the future (billing/tiers), so it's structural, not sprinkled:

- **Single write path.** All object writes go through one method,
  `ScopedObjectStore.put(key, stream) -> int`, which counts bytes as it streams. Usage
  mutation happens in exactly two places: `put` (+n) and `delete` (−n), both updating
  `User.storage_used_bytes` in the same operation as the object write. No handler ever does
  arithmetic on usage.
- **Quota gate at upload, twice.** (a) Reject early when `Content-Length` (if present) would
  exceed `quota − used`. (b) Enforce during streaming regardless — count bytes as they arrive
  and abort + delete the partial object the moment the ceiling is crossed. Never trust the
  header alone; it's client-supplied. Also enforce a per-file cap
  (`ORRERY_MAX_PDF_BYTES`, default 100 MiB) so one file can't be the whole quota.
- **Failure hygiene.** If ingest fails *after* the object landed (OCR explodes, embedding
  times out), the object and its usage are rolled back in `_run_ingest`'s except branch —
  today's version (main.py:193) leaks the file on failure; the rewrite must not leak the bytes
  *or* the accounting.
- **Quota covers raw PDFs only.** OCR cache and Chroma vectors are derived and rebuildable;
  metering them punishes users for our own storage choices. Revisit if derived data stops
  being ~proportional to raw data.
- **Reconciliation.** `python -m backend.tools.reconcile_storage` recomputes true usage from
  `ObjectStore.list("users/{id}/")` vs the counters, reports drift, `--fix` writes corrections.
  Counters drift eventually (crashes mid-upload); reconciliation is how the numbers stay
  billing-grade. Run it in CI against the test fixtures too.
- Surfaced everywhere it matters: `GET /api/auth/me` (own usage — frontend shows a usage bar
  near the upload affordance), 507-style error body on quota-exceeded uploads
  (`{"error": "quota_exceeded", "used": ..., "quota": ...}` so the UI can render a real
  message), and the Keeper lens (§8).

---

## 10. Object storage: the `ObjectStore` seam (MinIO-ready, MinIO-absent)

### 10.1 Verdict on shipping MinIO now

**No — but ship the interface now.** Reasons: (a) single-node deployment gains nothing from
MinIO except an extra container, another credential set, and a second backup story; (b) the
*expensive* part of the migration is not running MinIO, it's removing every assumption that a
PDF is a local path — symlinks, `FileResponse`, `original_path`, path-derived IDs. This tier
removes all of those. Once every byte flows through `ObjectStore` with S3-shaped keys, the
MinIO cut-over is: implement one class with `boto3`/`minio-py`, set
`ORRERY_OBJECT_STORE=s3` + endpoint/credentials env vars, run `mc mirror dbs/objects/
minio/orrery` (keys are already bucket-key shaped), restart. No schema change, no re-ingest,
no handler edits. That's the "never refactor this bit again" guarantee, purchased without the
operational cost today.

```python
# backend/services/objectstore.py
class ObjectStat(BaseModel):
    key: str
    size_bytes: int
    modified_at: datetime

class ObjectStore(Protocol):
    def put(self, key: str, stream: BinaryIO, max_bytes: int | None = None) -> int: ...
    def open(self, key: str) -> BinaryIO: ...          # streaming read
    def delete(self, key: str) -> None: ...
    def stat(self, key: str) -> ObjectStat | None: ...
    def list(self, prefix: str) -> list[ObjectStat]: ...

class LocalObjectStore:
    """Maps key → dbs/objects-root/{key}. The only class that touches pdf paths."""
```

Rules that keep the seam honest (violating any one of these re-earns the refactor):

1. No code outside `LocalObjectStore` constructs a filesystem path to a PDF.
2. Keys are POSIX, relative, S3-legal: `users/{user_id}/papers/{paper_id}.pdf`.
3. Reads are streams (`StreamingResponse`), never `FileResponse(path)`.
4. Anything that genuinely needs a local file (the OCR library probably wants a path) copies
   the stream to a `tempfile` and cleans up — it does not ask the store for its path.
5. No symlinks, no `rglob`, no directory semantics against objects.

### 10.2 The symlink tree dies; the tree goes virtual

`FilesystemService.rebuild_tree` / `update_symlink_status` / `make_symlink_name` and the whole
`dbs/output/` forest are removed. Every `PaperRecord` already carries `cluster_path` — the
tree the frontend renders is a pure function:

```python
# backend/services/tree.py
def build_tree(records: dict[str, PaperRecord]) -> TreeNode:
    """Group records by cluster_path segments; sort folders-first; O(n)."""
```

`GET /api/tree` calls it directly. Wins: no disk mutation on status change (the
`old_symlink_name` dance in the PATCH handler, main.py:141–145, disappears — the handler
becomes: update record, update Chroma metadata, save), no broken-symlink states, no
`output_new` swap dance, works identically on MinIO, and status rename bugs become
impossible. `symlink_name` is dropped from `PaperRecord`. If browsing PDFs in Finder ever
mattered, an optional `backend/tools/export_tree.py` can materialize a symlink tree on demand
— it's an export, not a source of truth.

This is the single biggest simplification in the plan and it's *required* for MinIO anyway —
doing it now is what makes decision §0.1-5 cheap.

---

## 11. Migration (Omar's data becomes the Keeper's galaxy)

One idempotent script, `python -m backend.tools.migrate_to_multiuser`:

1. Create `dbs/orrery.db`; create the Keeper user (`handle=omar`, role `keeper`, password
   prompted interactively — never hardcoded, never in env).
2. `dbs/papers.json` → `dbs/users/{keeper_id}/papers.json`, rewriting each record: new
   content-hash `paper_id` (§4.3), drop `symlink_name`, `original_path` →
   `source_filename` (basename only).
3. Copy `dbs/input/*.pdf` into the object root as `users/{keeper_id}/papers/{new_id}.pdf`.
4. Chroma: copy `paper_chunks`/`paper_vectors` into `u{keeper_id}_chunks`/`u{keeper_id}_papers`
   via `get(include=["embeddings","documents","metadatas"])` + `add`, rewriting ids and
   `paper_id` metadata to the new content-hash ids. **No re-OCR, no re-embedding** — the
   vectors move as-is.
5. Sum copied object sizes → `storage_used_bytes`; set the Keeper's quota generously
   (`ORRERY_KEEPER_QUOTA`, default 10 GiB).
6. Verify: paper count, chunk count, and total bytes match pre-migration; print a diff table.
   Old `dbs/input`, `dbs/output`, `dbs/papers.json`, and old collections are left in place
   (renamed `.pre-multiuser`) until a manual cleanup — the script never deletes source data.

Frontend migration is exactly the Tier 1 §12 seam: `auth/session.ts` swaps localStorage
fakery for `/api/auth/*` calls; `isOwner` becomes `me.handle === galaxy` and role arrives in
the session; observer mode points at `/api/tour/*`. Scene machine, gating, visuals untouched.
Plus two new small pieces: a real signup error path ("handle taken", "invite required" — the
Gate's honest small print finally retires) and the usage bar + Storage Ledger panel.

---

## 12. Build order and gates

| # | Phase | Size | Depends on | Gate to merge |
|---|---|---|---|---|
| 1 | Identity core: SQLite, signup/login/logout/me, cookies, rate limits | M | — | §3 rules tested; every legacy route still open (flag `ORRERY_AUTH_ENFORCED=false`) |
| 2 | `ObjectStore` + virtual tree: kill symlinks, stream PDFs, content-hash ids | L | — | §10 rules hold; tree JSON deep-equals old output for the real library; upload/read/status/reindex regression |
| 3 | `UserSpace` + namespacing: per-user stores/collections, migration script | L | 1, 2 | migration verify passes on the real `dbs/`; app boots with Keeper's galaxy intact |
| 4 | Enforcement: `current_space` on every route, DELETE endpoint, flip `ORRERY_AUTH_ENFORCED=true` | M | 3 | full §13 authz matrix green; anonymous gets 401 on every non-tour, non-auth route |
| 5 | Tour router + frontend observer rewire | S/M | 4 | Tier 1 recruiter script (UI plan §10.3-C) passes end-to-end against *real* auth |
| 6 | Quotas + accounting + reconciliation + Keeper lens + Storage Ledger UI | M | 4 | §9 tests incl. mid-stream abort; lens leaks nothing beyond §8 models |
| 7 | (Tier 3, someday) MinIO container | S | 2 | `mc mirror`, env flip, full regression — and nothing else, or phase 2 failed |

Phases 1 and 2 are independent — they can land in either order or in parallel. Phase 2 is
deliberately *before* namespacing: it's the highest-risk refactor and is easiest to verify
while the app is still single-user (diff the tree JSON, diff served bytes).

## 13. Testing

- **The authz matrix (§2) as a parameterized test.** Fixtures: keeper, two voyagers, one
  anonymous client; every row × every route asserts the exact status code. The cross-user PDF
  test (§6) is written first and must fail before phase 4 and pass after.
- **Unit:** handle validation + reserved list; argon2 round-trip; session expiry/revocation;
  `ScopedObjectStore` escape attempts (`../`, absolute keys, prefix spoofing like
  `users/{id}evil/`); quota mid-stream abort leaves no object and no usage delta; content-hash
  dedup returns 409; `build_tree` equivalence vs a recorded snapshot of today's symlink walk;
  reconciliation detects a hand-planted drift.
- **Response-model leak test:** serialize the §8 lens responses for a voyager whose records
  have every field populated; assert the words `status`, `summary`, `cluster_path` do not
  appear anywhere in the JSON. Cheap, brutal, catches the "someone added a field" regression.
- **Tour:** anonymous can read every tour route; anonymous gets 401/404 on every non-tour
  route; tour chat 429s on message 11.
- **Backend test infra exists** ([backend/tests/](../../backend/tests)) — extend it with an
  `httpx.AsyncClient` + FastAPI `TestClient` conftest and a tmp-path `dbs/` fixture.

## 14. Explicit non-goals (Tier 3+)

- OAuth / passkeys / email verification / password reset (reset = Keeper manually via a CLI
  tool for now).
- Voyager galaxies opening to visitors, `is_public`, cross-galaxy paper capture, shared-star
  rings.
- Global content dedup across users (content hashes make it possible later; don't build it).
- Billing, storage tiers beyond a per-user quota number.
- Admin moderation actions (delete/disable content) beyond the `disabled` user flag and the
  read-only lens.
- MinIO itself (§10.1 — the seam ships, the container doesn't).
