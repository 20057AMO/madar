"""Madar Team-Chat responsive UI E2E (Playwright, against the running 127.0.0.1:3000).

Bootstrap: same pattern as limits_ui.py -- forge an admin-session JWT from the
repo JWT_SECRET, inject into localStorage['wsd.token'] before first paint.

Covers the Chat responsive UX across three viewports:
  1. Desktop (1440x900) -- 270px rail, day separators, message grouping, FAB
  2. Tablet  (768x1024) -- pinned rail, collapse/expand, localStorage persistence
  3. Phone   (375x812)  -- drawer rail, hamburger, backdrop, touch-target buttons, char counter

Cleanup: channel e2e-ux-<stamp> deleted after run.

Run (host, container must be up):
    python backend/tests/e2e/chat_responsive_ui.py
Exit codes: 0 = all checks passed, 1 = failures, 42 = skipped (no reachable server).
"""
import os
import sys
import time

# Windows consoles default to a charmap codec; the UI now emits Arabic day
# labels ("اليوم"), so force UTF-8 before printing any check details.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import jwt
import requests
from playwright.sync_api import sync_playwright


def _base() -> str:
    return os.environ.get("WSD_E2E_BASE", "http://127.0.0.1:3000").rstrip("/")


def _secret() -> str:
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
                    return line.split("=", 1)[1].strip().strip('"')
    return os.environ.get("JWT_SECRET", "").strip()


def _token_for(user_id: str, username: str, role: str, tv: int, secret: str) -> str:
    return jwt.encode(
        {"id": user_id, "username": username, "role": role, "tv": tv, "jti": "e2e-chat"},
        secret,
        algorithm="HS256",
    )


def _api(path: str, method: str = "GET", body=None, token: str | None = None, timeout: int = 30):
    headers = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return requests.request(
        method, f"{_base()}/api{path}", json=body, headers=headers, timeout=timeout,
    )


def _find_admin():
    """Return (id, username) of the real admin via the API."""
    probe = _token_for("e2e-unknown-probe", "probe", "admin", 0, _secret())
    res = _api("/auth/status", token=probe)
    if res.status_code != 200:
        raise SystemExit(f"server not healthy: {res.status_code} {res.text[:200]}")
    data = res.json()
    if not data.get("hasUser"):
        raise SystemExit("no user configured -- run setup first")
    lst = _api("/users", token=probe)
    if lst.status_code != 200:
        raise SystemExit(f"could not list users: {lst.status_code}")
    for u in lst.json() or []:
        if u.get("role") == "admin":
            return u["id"], u["username"]
    raise SystemExit("no admin user found")


def _cleanup_channel(token: str, channel_id: str) -> None:
    _api(f"/chat-team/channels/{channel_id}", method="DELETE", token=token)


def _wheel_to_top(pg, container, steps: int = 30) -> None:
    """Real user scroll: hover the message list, wheel it fully to the top."""
    box = container.bounding_box()
    pg.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    for _ in range(steps):
        pg.mouse.wheel(0, -700)
        time.sleep(0.04)


def _wheel_to_bottom(pg, container, steps: int = 30) -> None:
    """Real user scroll: hover the message list, wheel it fully to the bottom."""
    box = container.bounding_box()
    pg.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    for _ in range(steps):
        pg.mouse.wheel(0, 700)
        time.sleep(0.04)


# -- Check accumulator ------------------------------------------------
checks: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    checks.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + (f"  {detail}" if detail else ""))


# -- Main --------------------------------------------------------------
def main() -> int:
    secret = _secret()
    if not secret:
        print("SKIP: JWT_SECRET not found in env or repo .env")
        return 42

    admin_id, admin_name = _find_admin()
    admin = _token_for(admin_id, admin_name, "admin", 0, secret)
    print(f". admin session forged for '{admin_name}'")

    # -- Create test channel + seed messages via API --------------------
    stamp = str(int(time.time()))
    chan_name = f"e2e-ux-{stamp}"
    res = _api("/chat-team/channels", method="POST", body={"name": chan_name}, token=admin)
    if res.status_code not in (200, 201):
        raise SystemExit(f"failed to create channel: {res.status_code} {res.text[:200]}")
    channel_id = res.json()["channel"]["id"]
    print(f". channel '{chan_name}' created ({channel_id})")

    # Seed messages:
    # - Two consecutive from the same user (grouping test)
    # - A long message (>4800 chars for counter)
    # - Several more to push scroll depth for FAB
    long_text = "A" * 4850
    msgs_to_send = [
        "Hello team -- first message in the channel",
        "Second message right after -- should group with the first",
        long_text,
        "Quick question about the sprint",
        "Anyone available for a review?",
        "Just pushed the latest changes to main",
        "Let me know when you are done with the PR",
        "Found a small issue -- will open a ticket",
        "Also, the CI pipeline passed on the last run",
        "Meeting notes: agreed on the new API contract",
        "Last message to push scroll deep enough for the FAB",
    ]
    sent_ids = []
    for text in msgs_to_send:
        mres = _api(
            "/chat-team/messages",
            method="POST",
            body={"channelId": channel_id, "text": text},
            token=admin,
        )
        if mres.status_code in (200, 201):
            sent_ids.append(mres.json().get("message", {}).get("id", ""))
    print(f". seeded {len(sent_ids)} messages into '{chan_name}'")

    browser = None
    all_console_errors: list[str] = []

    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            init = f"localStorage.setItem('wsd.token', '{admin}');"

            # ===========================================================
            # DESKTOP (1440x900) -- full rail, day-sep, grouping, FAB
            # ===========================================================
            print("\n-- Desktop 1440x900 --")
            pg = browser.new_page(viewport={"width": 1440, "height": 900})
            pg.add_init_script(init)
            console_errors: list[str] = []
            pg.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)

            pg.goto(f"{_base()}/#/chat", wait_until="load")

            # Wait for channel list, click test channel, wait for messages
            pg.wait_for_selector(".tchat-channel-row", timeout=10000)
            pg.locator(".tchat-channel-row", has_text=chan_name).first.click()
            pg.wait_for_selector(".tchat-msg", timeout=10000)
            time.sleep(1)

            # D1: Rail is ~300px wide, burger hidden, backdrop hidden
            rail = pg.locator(".tchat-rail")
            rail_box = rail.bounding_box()
            check(
                "desktop: rail width is 300px",
                rail_box is not None and 295 <= rail_box["width"] <= 310,
                f"width={rail_box['width'] if rail_box else 'None'}",
            )
            burger_d = pg.locator(".tchat-burger")
            check(
                "desktop: hamburger button is hidden",
                burger_d.count() == 0 or not burger_d.is_visible(),
            )
            backdrop_d = pg.locator(".tchat-backdrop")
            check(
                "desktop: backdrop is hidden",
                backdrop_d.count() == 0 or not backdrop_d.is_visible(),
            )

            # D2: Day separator present
            day_seps = pg.locator(".tchat-day-sep")
            check("desktop: day separator is present", day_seps.count() >= 1)
            if day_seps.count() > 0:
                sep_text = day_seps.first.inner_text()
                check("desktop: day separator says 'Today'",
                      "Today" in sep_text or "اليوم" in sep_text, sep_text)

            # D3: Message grouping -- consecutive same-user msg has .grouped
            grouped = pg.locator(".tchat-msg.grouped")
            check(
                "desktop: grouped messages exist (consecutive same-user)",
                grouped.count() >= 1,
                f"grouped={grouped.count()}",
            )

            # D4: FAB -- scroll to the bottom with real wheel input, confirm the
            #     FAB stays hidden while AT the bottom, then scroll back up and
            #     confirm it appears (the app's passive scroll listener drives
            #     showJump). Real wheel events exercise the actual UX path.
            msg_container = pg.locator(".tchat-messages")
            _wheel_to_bottom(pg, msg_container)
            time.sleep(0.5)
            fab_el = pg.locator(".tchat-jump-bottom")
            check(
                "desktop: FAB hidden while at the bottom",
                fab_el.count() >= 1 and not fab_el.is_visible(),
            )
            _wheel_to_top(pg, msg_container)
            fab_visible = False
            for _ in range(25):
                time.sleep(0.2)
                if fab_el.is_visible():
                    fab_visible = True
                    break
            check("desktop: FAB appears after scrolling up", fab_visible)

            if fab_visible:
                fab_el.click()
                time.sleep(1.2)
                at_bottom = msg_container.evaluate(
                    "(el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 60"
                )
                check("desktop: FAB click scrolls to bottom", at_bottom)

            # D5: Connection dot green
            check("desktop: connection dot green (.tchat-conn-open)",
                  pg.locator(".tchat-conn-open").count() >= 1)

            # D6: Composer visible
            ta = pg.locator(".tchat-textarea")
            check("desktop: composer textarea visible",
                  ta.count() == 1 and ta.is_visible())

            # D7: Char counter at >4800
            ta.click()
            ta.fill("A" * 4850)
            time.sleep(0.3)
            ctr = pg.locator(".tchat-char-counter")
            ctr_vis = ctr.count() >= 1 and ctr.is_visible()
            check("desktop: char counter appears at >4800 chars", ctr_vis)
            if ctr_vis:
                ct = ctr.inner_text()
                check("desktop: char counter shows '4850/5000'",
                      "4850" in ct and "5000" in ct, ct)
            ta.fill("")
            time.sleep(0.2)

            # D8: Message action buttons present and touchable
            first_msg = pg.locator(".tchat-msg").first
            first_msg.hover()
            time.sleep(0.3)
            actions = pg.locator(".tchat-msg-side .tchat-msg-action")
            if actions.count() > 0:
                ab = actions.first.bounding_box()
                check("desktop: message action buttons present (>=24x24)",
                      ab is not None and ab["width"] >= 24 and ab["height"] >= 24,
                      f"size={ab['width'] if ab else '?'}x{ab['height'] if ab else '?'}")
            else:
                check("desktop: message action buttons present", False, "none found")

            all_console_errors.extend([f"[desktop] {e}" for e in console_errors])
            pg.close()

            # ===========================================================
            # TABLET (768x1024) -- pinned rail, collapse, persistence
            # ===========================================================
            print("\n-- Tablet 768x1024 --")

            # T1: Rail pinned open by default (fresh localStorage)
            pg = browser.new_page(viewport={"width": 768, "height": 1024})
            pg.add_init_script(init)
            pg.goto(f"{_base()}/#/chat", wait_until="load")
            pg.wait_for_selector(".tchat-channel-row", timeout=10000)
            pg.locator(".tchat-channel-row", has_text=chan_name).first.click()
            pg.wait_for_selector(".tchat-msg", timeout=10000)
            time.sleep(0.8)

            check("tablet: rail pinned open by default",
                  pg.locator(".tchat-rail").is_visible())

            # T2: Burger/collapse button visible
            burger_t = pg.locator(".tchat-burger")
            check("tablet: burger/collapse button visible", burger_t.is_visible())

            # T3: Collapse hides rail, re-open works
            collapse_btn = pg.locator(".tchat-collapse-btn")
            has_collapse = collapse_btn.count() > 0 and collapse_btn.is_visible()
            if has_collapse:
                collapse_btn.click()
                time.sleep(0.5)
                check("tablet: collapse hides rail",
                      pg.locator(".tchat-rail.collapsed").count() >= 1)

                burger_t.click()
                time.sleep(0.5)
                check("tablet: burger re-opens rail",
                      pg.locator(".tchat-rail:not(.collapsed)").count() >= 1)
            else:
                check("tablet: collapse toggles rail", False, "no collapse btn")

            # T4: Reload persists collapsed state
            #     Collapse the rail and verify localStorage writes '1' before reload.
            if has_collapse:
                # Ensure rail is open first (burger already re-opened it)
                collapse_btn.click()
                time.sleep(0.6)
                # Verify localStorage was actually written
                ls_val = pg.evaluate("localStorage.getItem('wsd.chat.railCollapsed')")
                collapsed_before = pg.locator(".tchat-rail.collapsed").count() >= 1
                check(
                    "tablet: collapse writes localStorage + applies class",
                    ls_val == "1" and collapsed_before,
                    f"ls={ls_val!r} collapsed={collapsed_before}",
                )
                pg.reload(wait_until="load")
                time.sleep(0.5)
                ls_after = pg.evaluate("localStorage.getItem('wsd.chat.railCollapsed')")
                collapsed_after = pg.locator(".tchat-rail.collapsed").count() >= 1
                check("tablet: collapsed state persists after reload",
                      ls_after == "1" and collapsed_after,
                      f"ls={ls_after!r} collapsed={collapsed_after}")
                # Re-expand via burger for subsequent checks
                if burger_t.is_visible():
                    burger_t.click()
                    time.sleep(0.5)
            else:
                check("tablet: collapsed state persists after reload", False, "no collapse btn")

            # T5: Connection dot
            check("tablet: connection dot green",
                  pg.locator(".tchat-conn-open").count() >= 1)

            pg.close()

            # ===========================================================
            # PHONE (375x812) -- drawer rail, backdrop, touch targets
            # ===========================================================
            print("\n-- Phone 375x812 --")
            # Real touch emulation: the 44px touch-target rules are gated on
            # @media (hover: none) AND (pointer: coarse) -- a plain desktop
            # viewport still reports pointer:fine, so those styles never apply.
            phone_ctx = browser.new_context(
                viewport={"width": 375, "height": 812},
                is_mobile=True,
                has_touch=True,
                device_scale_factor=2,
            )
            pg = phone_ctx.new_page()
            pg.add_init_script(init)
            console_errs_phone: list[str] = []
            pg.on("console", lambda msg: console_errs_phone.append(msg.text) if msg.type == "error" else None)

            pg.goto(f"{_base()}/#/chat", wait_until="load")
            # On phone, the rail is a hidden drawer (translated off-screen).
            # With a single channel the component auto-selects it via
            # setActiveId in the channel-list useEffect, so we must NOT
            # click a channel row (it's not in the viewport).  Just wait
            # for messages to appear.
            pg.wait_for_selector(".tchat-msg", timeout=10000)
            time.sleep(1)

            # P1: Rail hidden by default (drawer, translated off-screen).
            #     `is_visible()` returns True for a translateX(-110%) drawer (it
            #     still has a bounding box), so check the box is fully off the
            #     edge instead.  Direction-aware: the app is RTL-first, so the
            #     closed drawer may sit off the RIGHT edge (x >= viewport) in
            #     RTL or off the LEFT edge (x+width <= 0) in LTR.
            rail_p = pg.locator("#tchat-rail")
            rail_box_p = rail_p.bounding_box()
            vp_w = pg.evaluate("() => window.innerWidth")
            rail_offscreen = (
                rail_box_p is not None
                and (
                    rail_box_p["x"] + rail_box_p["width"] <= 0
                    or rail_box_p["x"] >= vp_w - 1
                )
            )
            check(
                "phone: rail hidden by default (drawer)",
                rail_offscreen,
                f"box_x={rail_box_p['x'] if rail_box_p else '?'}",
            )

            # P2: Hamburger visible
            burger_p = pg.locator(".tchat-burger")
            check("phone: hamburger visible", burger_p.is_visible())

            # P3: Hamburger opens rail + backdrop appears
            burger_p.click()
            time.sleep(0.5)
            rail_open = pg.locator(".tchat-rail.open").count() >= 1
            check("phone: hamburger opens rail", rail_open)
            check("phone: backdrop visible when drawer open",
                  pg.locator(".tchat-backdrop.open").count() >= 1)

            if rail_open:
                # P4: Backdrop click closes drawer. Pick a point on the
                #     backdrop that is NOT under the drawer (direction-aware:
                #     the drawer docks right in RTL, left in LTR).
                backdrop_p = pg.locator(".tchat-backdrop.open")
                bd_box = backdrop_p.bounding_box()
                rail_now = rail_p.bounding_box()
                if bd_box is not None and rail_now is not None:
                    rail_center = rail_now["x"] + rail_now["width"] / 2
                    if rail_center > bd_box["x"] + bd_box["width"] / 2:
                        # Drawer docked right -> click left of it
                        click_x = max(10, rail_now["x"] - 40)
                    else:
                        # Drawer docked left -> click right of it
                        click_x = min(bd_box["width"] - 10,
                                      rail_now["x"] + rail_now["width"] + 40)
                    backdrop_p.click(position={"x": click_x, "y": 400})
                else:
                    backdrop_p.click()
                time.sleep(0.5)
                check("phone: backdrop click closes drawer",
                      pg.locator(".tchat-rail.open").count() == 0)

                # P4b: Hamburger opens again, then channel click closes drawer
                burger_p.click()
                time.sleep(0.5)
                # Click a channel row inside the now-open drawer
                row_in_drawer = pg.locator(".tchat-channel-row", has_text=chan_name).first
                row_in_drawer.click(force=True)
                time.sleep(0.5)
                check("phone: channel click closes drawer",
                      pg.locator(".tchat-rail.open").count() == 0)
            else:
                check("phone: backdrop click closes drawer", False, "rail never opened")
                check("phone: channel click closes drawer", False, "rail never opened")

            # P5: Message action buttons >= 44x44 (coarse pointer rule)
            first_msg_p = pg.locator(".tchat-msg").first
            first_msg_p.hover()
            time.sleep(0.4)
            actions_p = pg.locator(".tchat-msg-side .tchat-msg-action")
            if actions_p.count() > 0:
                abp = actions_p.first.bounding_box()
                check("phone: message action buttons >= 44x44",
                      abp is not None and abp["width"] >= 44 and abp["height"] >= 44,
                      f"size={abp['width'] if abp else '?'}x{abp['height'] if abp else '?'}")
            else:
                check("phone: message action buttons >= 44x44", False, "none found")

            # P6: Composer visible
            ta_p = pg.locator(".tchat-textarea")
            check("phone: composer textarea visible",
                  ta_p.count() == 1 and ta_p.is_visible())

            # P7: Char counter at >4800
            ta_p.click()
            ta_p.fill("B" * 4850)
            time.sleep(0.3)
            ctr_p = pg.locator(".tchat-char-counter")
            ctr_p_vis = ctr_p.count() >= 1 and ctr_p.is_visible()
            check("phone: char counter appears at >4800 chars", ctr_p_vis)
            if ctr_p_vis:
                ct = ctr_p.inner_text()
                check("phone: char counter shows '4850/5000'",
                      "4850" in ct and "5000" in ct, ct)
            ta_p.fill("")
            time.sleep(0.2)

            # P8: Connection dot green
            check("phone: connection dot green",
                  pg.locator(".tchat-conn-open").count() >= 1)

            all_console_errors.extend([f"[phone] {e}" for e in console_errs_phone])
            pg.close()
            phone_ctx.close()

            # ===========================================================
            # Console-error gate
            # ===========================================================
            real_errors = [
                e for e in all_console_errors
                if "WebSocket" not in e
                and "ResizeObserver" not in e
                and "favicon" not in e.lower()
            ]
            check(
                "no new console errors across viewports",
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
        _cleanup_channel(admin, channel_id)

    failed = [n for n, ok, _ in checks if not ok]
    print()
    print(f"RESULT: {'OK' if not failed else 'FAIL'}  {len(checks) - len(failed)}/{len(checks)} checks passed")
    if failed:
        print("FAILED:", "; ".join(failed))
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
