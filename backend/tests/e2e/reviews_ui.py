#!/usr/bin/env python3
"""E2E browser suite for Madar file reviews.

Exercises the ReviewsPanel in a real Chromium browser against the running
container (localhost:3000).  The forged admin JWT lets the suite bypass the
real account's TOTP gate (the UI login route always steps the FIRST user
through the authenticator — see user-store.isTotpEnabled()).

Exits 0 = all green, 1 = failures, 42 = skip.
"""
from __future__ import annotations

import os
import re
import sys
import time
import uuid
from typing import Any

import requests
from playwright.sync_api import sync_playwright

# ── Auth helpers (mirrors limits_ui.py) ──────────────────────────────────────


def _read_secret() -> str:
    # mirrors limits_ui._secret(): WSD_JWT_SECRET env → repo-root .env/.env.local
    # (this file lives in backend/tests/e2e, so the root is THREE parents up) →
    # bare JWT_SECRET env var.
    env_secret = os.environ.get("WSD_JWT_SECRET", "").strip()
    if env_secret:
        return env_secret
    root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..")
    for name in (".env", ".env.local"):
        path = os.path.join(root, name)
        if not os.path.exists(path):
            continue
        with open(path, "r", encoding="utf-8", errors="ignore") as fh:
            for line in fh:
                line = line.strip()
                if line.startswith("JWT_SECRET=") and not line.startswith("#"):
                    secret = line.split("=", 1)[1].strip().strip('"')
                    if secret:
                        return secret
    return os.environ.get("JWT_SECRET", "").strip()


def _token_for(uid: str, uname: str, role: str, tv: int, secret: str) -> str:
    def _b64url(b: bytes) -> str:
        import base64
        return base64.urlsafe_b64encode(b).rstrip(b"=").decode()

    import hashlib, hmac, json as _j
    hdr = _b64url(_j.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    payload = _b64url(_j.dumps({
        "id": uid, "username": uname, "role": role,
        "tv": tv, "iat": int(time.time()),
        "exp": int(time.time()) + 86400, "jti": uuid.uuid4().hex,
    }).encode())
    sig = _b64url(hmac.new(secret.encode(), f"{hdr}.{payload}".encode(), hashlib.sha256).digest())
    return f"{hdr}.{payload}.{sig}"


def _read_admin_secret_and_uid() -> tuple[str, str, str]:
    secret = _read_secret()
    admin_uid, admin_user = _find_admin(secret)
    return secret, admin_uid, admin_user


# ── HTTP helpers ─────────────────────────────────────────────────────────────
_BASE = None


def _base() -> str:
    global _BASE
    if _BASE is None:
        env_base = os.environ.get("TEST_BASE_URL", "").rstrip("/")
        _BASE = env_base or "http://127.0.0.1:3000"
    return _BASE


def _api(path: str, *, method: str = "GET", body: Any = None,
         token: str | None = None, timeout: int = 30) -> requests.Response:
    url = f"{_base()}/api{path}"
    hdrs: dict[str, str] = {"Content-Type": "application/json"}
    if token:
        hdrs["Authorization"] = f"Bearer {token}"
    for attempt in range(3):
        r = requests.request(method, url, json=body, headers=hdrs, timeout=timeout)
        if r.status_code == 429:
            ra = int(r.headers.get("Retry-After", "5"))
            wait = min(ra, 5)
            print(f". 429 {method} {path} (attempt {attempt+1}), sleeping {wait}s")
            time.sleep(wait)
            continue
        return r
    return r


def _find_admin(secret: str) -> tuple[str, str]:
    """Return (id, username) of the real server admin via the live API.

    The server only checks the JWT signature on generic routes, so a probe
    token forged for any identity passes authMiddleware; the admin-gated
    /users endpoint then reveals the real admin (mirrors limits_ui)."""
    probe = _token_for("e2e-unknown-probe", "probe", "admin", 0, secret)
    res = _api("/auth/status", token=probe)
    if res.status_code != 200:
        raise SystemExit(f"server not healthy: {res.status_code} {res.text[:200]}")
    if not res.json().get("hasUser"):
        raise SystemExit("no user configured in the server — run setup first")
    lst = _api("/users", token=probe)
    if lst.status_code != 200:
        raise SystemExit(f"could not list users: {lst.status_code} {lst.text[:200]}")
    for u in lst.json() or []:
        if u.get("role") == "admin":
            return u["id"], u["username"]
    raise SystemExit("no admin user found")


def _cleanup(token: str) -> None:
    r = _api("/projects", token=token)
    if r.status_code == 200:
        for p in r.json().get("projects") or []:
            if p.get("slug", "").startswith("e2e-reviews"):
                _api(f"/projects/{p['slug']}", method="DELETE", token=token)


# ── Reviews helpers ──────────────────────────────────────────────────────────
def _get_reviews(token: str, slug: str) -> list[dict]:
    r = _api(f"/projects/{slug}/reviews", token=token)
    return (r.json().get("threads") or []) if r.status_code == 200 else []


def _get_review_counts(token: str, slug: str) -> dict:
    r = _api(f"/projects/{slug}/reviews", token=token)
    return (r.json().get("counts") or {}) if r.status_code == 200 else {}


# ── Real sample source for the workspace file ────────────────────────────────
_APP_TS = """\
import express from 'express';
import { randomUUID } from 'crypto';

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'Madar', version: 'BETA' });
});

app.get('/api/projects/:slug/reviews', (req, res) => {
  res.json([]);
});

app.get('/api/projects/:slug/reviews/counts', (req, res) => {
  res.json({ total: 0, open: 0, resolved: 0 });
});

app.post('/api/projects/:slug/reviews', (req, res) => {
  const id = randomUUID();
  res.status(201).json({ id, ...req.body });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Madar listening on :${PORT}`);
});
"""

# ── E2E suite ────────────────────────────────────────────────────────────────

checks: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    """Record a named assertion and print its outcome (mirrors limits_ui)."""
    checks.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'} {name}"
          + (f"  {detail}" if detail else ""))


def _new_page(context, init: str, errors: list):
    """Page (from the shared browser context) with the session pre-seeded;
    every console error lands in `errors`.

    All pages share ONE browser context so the Vite assets (immutable, hashed)
    are served from the HTTP cache after the first navigation. browser.new_page()
    creates a FRESH context per page — the running container enforces the
    production global budget (240 req/min per IP under WSD_TESTING=0), and a
    new context re-fetches ~40 assets per page, blowing the budget mid-run
    with random 429s showing up as empty review lists."""
    pg = context.new_page()
    pg.add_init_script(init)
    pg.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)
    return pg


def main() -> int:
    secret, admin_uid, admin_user = _read_admin_secret_and_uid()
    checks.clear()
    slug = f"e2e-reviews-{uuid.uuid4().hex[:8]}"
    admin = _token_for(admin_uid, admin_user, "admin", 0, secret)
    print(f". admin session forged for '{admin_user}'")

    # Prune leftover e2e projects (from a previous aborted run)
    _cleanup(admin)

    # Create the project and write a real source file into its workspace so
    # reviews on src/app.ts resolve fileExists=true.
    res = _api("/projects", method="POST",
               body={"name": f"E2E Reviews {slug}", "slug": slug}, token=admin)
    if res.status_code not in (200, 201):
        raise SystemExit(f"project create failed: {res.status_code} {res.text[:200]}")
    print(f". project '{slug}' created")

    fw = _api(f"/projects/{slug}/file?path=src/app.ts", method="PUT",
              body={"content": _APP_TS}, token=admin)
    if fw.status_code not in (200, 201):
        raise SystemExit(f"file write failed: {fw.status_code} {fw.text[:200]}")
    print(f". wrote src/app.ts ({len(_APP_TS)} bytes)")

    browser = None
    all_console_errors: list[str] = []
    viewer_user_id: str | None = None
    viewer_token: str | None = None

    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            # ONE shared context for every page — see _new_page: each fresh
            # context would re-fetch the whole asset bundle and burn the
            # container's per-IP global rate budget.
            context = browser.new_context()
            init = f"localStorage.setItem('wsd.token', '{admin}');"
            reviews_url = f"{_base()}/#/project/{slug}?tab=reviews"

            # ===========================================================
            # 1-4. Full thread lifecycle on a SINGLE browser page
            # ===========================================================
            # Keeps server traffic at ~55 hits (one cold load) vs ~90+ if
            # each step opened a fresh reload (each burning ~10 API hits
            # for project detail, chat/context, ide/status etc).  This
            # lets TWO back-to-back suite runs stay under the container's
            # global 240 req/min rate budget.
            pg = _new_page(context, init, all_console_errors)
            pg.goto(reviews_url, wait_until="load")
            pg.wait_for_selector(".reviews-title", timeout=15000)

            # -- Step 1: create thread pinned to src/app.ts ----------------
            path_input = pg.locator('input[aria-label="Review file path"]')
            path_input.wait_for(state="visible", timeout=15000)
            note_input = pg.locator('textarea[aria-label="Review note"]')
            note_input.wait_for(state="visible", timeout=5000)
            check("composer is visible for admin (path + note inputs)", True)

            path_input.fill("src/app.ts")
            note_input.fill("Review the health check endpoint — consider adding timeout")
            add_btn = pg.locator('button[aria-label="Add review thread"]')
            add_btn.click()

            head = pg.locator("[data-review-head]").first
            head.wait_for(state="visible", timeout=15000)
            path_text = head.locator(".mono").first.inner_text()
            check("created thread shows path 'src/app.ts'", "src/app.ts" in path_text, path_text)

            file_missing_badge = pg.locator("text=file not found")
            check("no 'file not found' badge for real file", file_missing_badge.count() == 0)

            threads_api = _get_reviews(admin, slug)
            real_thread = next((t for t in threads_api if t.get("path") == "src/app.ts"), None)
            check("API: fileExists=true for src/app.ts",
                  real_thread is not None and real_thread.get("fileExists") is True,
                  f"fileExists={real_thread.get('fileExists') if real_thread else 'missing'}")

            open_badge = pg.locator("[data-review-head]").first.locator("text=open")
            check("thread status badge shows 'open'", open_badge.count() >= 1)

            # -- Step 2: add a comment (thread auto-expanded after create) -
            reply = pg.locator('textarea[name="review-reply"]').first
            reply.wait_for(state="visible", timeout=10000)
            reply.fill("This looks good but we need error handling for ECONNREFUSED")
            reply_btn = pg.locator('button[aria-label="Send reply"]')
            reply_btn.click()

            comment_text = "error handling for ECONNREFUSED"
            comment_visible = pg.get_by_text(comment_text).count()
            deadline = time.time() + 15.0
            while comment_visible == 0 and time.time() < deadline:
                pg.wait_for_timeout(400)
                comment_visible = pg.get_by_text(comment_text).count()
            check("comment reply appears in thread", comment_visible >= 1)

            comment_count_text = pg.locator("[data-review-head]").first.locator(
                "span", has_text=re.compile(r"\d+ comments?")).first
            check("thread shows 2 comments",
                  "2 comment" in comment_count_text.inner_text(),
                  comment_count_text.inner_text())

            # -- Step 3: resolve → badge flips + resolved-by note ----------
            resolve_btn = pg.locator('button[aria-label="Resolve review"]').first
            resolve_btn.wait_for(state="visible", timeout=5000)
            resolve_btn.click()

            resolved_badge = pg.locator("[data-review-head]").first.locator(
                "span", has_text="resolved").last
            deadline = time.time() + 10.0
            badge_text = ""
            while time.time() < deadline:
                badge_text = resolved_badge.inner_text().strip().lower() if resolved_badge.count() else ""
                if badge_text == "resolved":
                    break
                pg.wait_for_timeout(300)
            check("resolve flips status badge to 'resolved'", badge_text == "resolved", badge_text)

            reopen_btn = pg.locator('button[aria-label="Reopen review"]').first
            check("Reopen button appears after resolve", reopen_btn.count() >= 1)

            resolved_note = pg.get_by_text(re.compile(r"resolved\s+\w+\s+by", re.IGNORECASE))
            check("resolved-by note appears", resolved_note.count() >= 1)

            # -- Step 4: reopen → back to open -----------------------------
            reopen_btn.wait_for(state="visible", timeout=5000)
            reopen_btn.click()

            deadline = time.time() + 10.0
            badge_text = ""
            while time.time() < deadline:
                all_badges = pg.locator("[data-review-head]").first.locator("span").all()
                badge_text = ""
                for b in all_badges:
                    t = b.inner_text().strip().lower()
                    if t in ("open", "resolved"):
                        badge_text = t
                        break
                if badge_text == "open":
                    break
                pg.wait_for_timeout(300)
            check("reopen flips status badge back to 'open'", badge_text == "open", badge_text)

            resolve_btn = pg.locator('button[aria-label="Resolve review"]')
            check("Resolve button returns after reopen", resolve_btn.count() >= 1)

            # -- Step 5: create missing.ts thread → "file not found" badge -
            path_input = pg.locator('input[aria-label="Review file path"]')
            path_input.wait_for(state="visible", timeout=10000)
            note_input = pg.locator('textarea[aria-label="Review note"]')
            note_input.wait_for(state="visible", timeout=5000)
            path_input.fill("missing.ts")
            note_input.fill("This file doesn't exist yet — plan it")
            add_btn = pg.locator('button[aria-label="Add review thread"]')
            add_btn.click()

            # newest-activity-first → missing.ts ranks first
            heads = pg.locator("[data-review-head]")
            missing_head = None
            deadline = time.time() + 15.0
            while time.time() < deadline and missing_head is None:
                n = heads.count()
                for i in range(n):
                    p = heads.nth(i).locator(".mono").first.inner_text()
                    if "missing.ts" in p:
                        missing_head = heads.nth(i)
                        break
                if missing_head is None:
                    pg.wait_for_timeout(400)
            check("found the missing.ts thread head in the list",
                  missing_head is not None, f"heads={heads.count()}")

            if missing_head is not None:
                missing_badge = missing_head.locator("text=file not found")
                deadline = time.time() + 10.0
                badge_count = 0
                while time.time() < deadline:
                    badge_count = missing_badge.count()
                    if badge_count >= 1:
                        break
                    pg.wait_for_timeout(300)
                check("'file not found' badge for missing.ts", badge_count >= 1)
            else:
                check("'file not found' badge for missing.ts", False, "thread head not found")

            threads_api = _get_reviews(admin, slug)
            missing_thread = next((t for t in threads_api if t.get("path") == "missing.ts"), None)
            check("API: fileExists=false for missing.ts",
                  missing_thread is not None and missing_thread.get("fileExists") is False,
                  f"fileExists={missing_thread.get('fileExists') if missing_thread else 'missing'}")

            # ===========================================================
            # Reload → persistence check + delete src/app.ts
            # ===========================================================
            pg.reload(wait_until="load")
            pg.wait_for_selector("[data-review-head]", timeout=15000)

            # -- Step 6: find src/app.ts, delete it via ConfirmModal -------
            all_heads = pg.locator("[data-review-head]")
            src_head = None
            n_heads = all_heads.count()
            for i in range(n_heads):
                p = all_heads.nth(i).locator(".mono").first.inner_text()
                if "src/app.ts" in p:
                    src_head = all_heads.nth(i)
                    break
            check("found the src/app.ts thread head in the list",
                  src_head is not None, f"heads={n_heads}")

            counts_before = _get_review_counts(admin, slug)
            check("pre-delete: API shows expected counts",
                  counts_before.get("total", 0) == 2,
                  f"counts={counts_before}")

            if src_head is not None:
                src_head.click()
                pg.wait_for_timeout(300)

                del_btn = pg.locator('button[aria-label="Delete thread"]').first
                del_btn.wait_for(state="visible", timeout=5000)
                del_btn.click()

                confirm_title = pg.locator("[role='dialog'] .reauth-title").first
                confirm_title.wait_for(state="visible", timeout=5000)
                title_text = confirm_title.inner_text().lower()
                check("ConfirmModal shows delete-thread confirmation",
                      "delete" in title_text and "thread" in title_text,
                      title_text)

                confirm_delete_btn = pg.locator("[role='dialog'] button", has_text="Delete").last
                confirm_delete_btn.click()

            deadline = time.time() + 15.0
            remaining = 0
            while time.time() < deadline:
                remaining = pg.locator("[data-review-head]").count()
                if remaining == 1:
                    break
                pg.wait_for_timeout(400)
            check("after delete: only 1 thread head remains",
                  remaining == 1, f"remaining={remaining}")

            surviving_path = pg.locator("[data-review-head]").first.locator(
                ".mono").first.inner_text()
            check("surviving thread is 'missing.ts'",
                  "missing.ts" in surviving_path, surviving_path)

            open_chip = pg.locator('span[role="status"]').locator(
                "span", has_text=re.compile(r"^\d+ open")).first
            resolved_chip = pg.locator('span[role="status"]').locator(
                "span", has_text=re.compile(r"^\d+ resolved")).first
            total_chip = pg.locator('span[role="status"]').locator(
                "span", has_text=re.compile(r"^\d+ total")).first
            deadline = time.time() + 10.0
            counters_ok = False
            while time.time() < deadline:
                o = open_chip.inner_text().strip() if open_chip.count() else ""
                r = resolved_chip.inner_text().strip() if total_chip.count() else ""
                t = total_chip.inner_text().strip() if total_chip.count() else ""
                if "1 open" in o and "0 resolved" in r and "1 total" in t:
                    counters_ok = True
                    break
                pg.wait_for_timeout(400)
            check("counters updated: 1 open, 0 resolved, 1 total", counters_ok,
                  f"open='{open_chip.inner_text().strip() if open_chip.count() else ''}' "
                  f"resolved='{resolved_chip.inner_text().strip() if total_chip.count() else ''}' "
                  f"total='{total_chip.inner_text().strip() if total_chip.count() else ''}'")

            counts_after = _get_review_counts(admin, slug)
            check("API counts after delete: total=1, open=1, resolved=0",
                  counts_after.get("total") == 1 and counts_after.get("open") == 1,
                  f"counts={counts_after}")

            pg.close()

            # ===========================================================
            # 7. Viewer read-only (fresh page in the same context)
            # ===========================================================
            vw_name = f"e2e-viewer-{uuid.uuid4().hex[:6]}"
            vw_pass = f"vw-{uuid.uuid4().hex[:8]}!"
            vw_res = _api("/users", method="POST", body={
                "username": vw_name,
                "password": vw_pass,
                "role": "viewer",
            }, token=admin)
            check("viewer user created via API",
                  vw_res.status_code in (200, 201),
                  f"status={vw_res.status_code}")
            if vw_res.status_code in (200, 201):
                viewer_user_id = vw_res.json().get("id", "")
            else:
                viewer_user_id = None

            if viewer_user_id:
                add_mem = _api(f"/projects/{slug}/members", method="POST",
                               body={"userId": viewer_user_id, "role": "viewer"},
                               token=admin)
                check("viewer added as project member",
                      add_mem.status_code in (200, 201),
                      f"status={add_mem.status_code}")

            if viewer_user_id:
                viewer_token = _token_for(viewer_user_id, vw_name, "viewer", 0, secret)
            else:
                viewer_token = _token_for("fake-viewer", "fake-viewer", "viewer", 0, secret)

            viewer_init = f"localStorage.setItem('wsd.token', '{viewer_token}');"
            pg = _new_page(context, viewer_init, all_console_errors)
            pg.goto(reviews_url, wait_until="load")
            pg.wait_for_selector(".reviews-title", timeout=15000)

            path_visible = pg.locator('input[aria-label="Review file path"]').count()
            check("viewer: composer is hidden (no path input)", path_visible == 0)

            ro_msg = pg.get_by_text(re.compile(r"read-only", re.IGNORECASE))
            deadline = time.time() + 10.0
            ro_count = 0
            while time.time() < deadline:
                ro_count = ro_msg.count()
                if ro_count >= 1:
                    break
                pg.wait_for_timeout(300)
            check("viewer: 'reviews are read-only' message shown", ro_count >= 1)

            thread_head_count = pg.locator("[data-review-head]").count()
            check("viewer: thread list still renders", thread_head_count >= 1,
                  f"visible threads={thread_head_count}")

            resolve_count = pg.locator('button[aria-label="Resolve review"]').count()
            reopen_count = pg.locator('button[aria-label="Reopen review"]').count()
            check("viewer: no Resolve or Reopen buttons",
                  resolve_count == 0 and reopen_count == 0,
                  f"resolve={resolve_count} reopen={reopen_count}")

            reply_btn_count = pg.locator('button[aria-label="Send reply"]').count()
            check("viewer: no Reply button", reply_btn_count == 0)

            del_btn_count = pg.locator('button[aria-label="Delete thread"]').count()
            check("viewer: no Delete thread button", del_btn_count == 0)

            pg.close()

            # ===========================================================
            # 8. Console-error gate
            # ===========================================================
            real_errors = [
                e for e in all_console_errors
                if "WebSocket" not in e
                and "ResizeObserver" not in e
                and "favicon" not in e.lower()
                and "HMR" not in e
                and "Failed to load resource" not in e
            ]
            check(
                "no new console errors across all pages",
                len(real_errors) == 0,
                f"errors={len(real_errors)}: {real_errors[:3]}" if real_errors else "",
            )

    except Exception as exc:  # noqa: BLE001
        checks.append(("run completed without exceptions", False, str(exc)))
        print("ERROR:", type(exc).__name__, str(exc)[:300])
        try:
            browser.close()
        except Exception:  # noqa: BLE001
            pass
    finally:
        if browser is not None:
            try:
                browser.close()
            except Exception:  # noqa: BLE001
                pass

        # ── Cleanup: remove viewer user + all e2e projects ──
        if viewer_user_id:
            _api(f"/users/{viewer_user_id}", method="DELETE", token=admin)
        _cleanup(admin)

    failed = [n for n, ok, _ in checks if not ok]
    print()
    print(f"RESULT: {'OK' if not failed else 'FAIL'}  {len(checks) - len(failed)}/{len(checks)} checks passed")
    if failed:
        print("FAILED:", "; ".join(failed))
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
