#!/usr/bin/env python3
"""End-to-end test of the settings panel.

Drives headless Firefox against the running app and checks the parts that only
exist in the browser: the panel renders, the image-generation switch saves
through to the API, the header reflects it, and "restore defaults" undoes it.

Usage: python3 local/e2e_settings_test.py [--app http://127.0.0.1:3000]
"""
from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from e2e_voice_test import GECKO_PORT, WebDriver, log  # noqa: E402

PANEL_OPEN = "const b = document.querySelector('.model-settings-toggle'); if (b) b.click(); return !!b;"

PANEL_STATE = r"""
const groups = [...document.querySelectorAll('.settings-group-heading span')].map(n => n.innerText);
const toggle = document.querySelector('.settings-switch input');
return JSON.stringify({
  groups,
  imageryEnabled: toggle ? toggle.checked : null,
  switchLabel: (document.querySelector('.settings-switch span') || {}).innerText || '',
  chip: (document.querySelector('.local-chip') || {}).innerText || '',
  saveDisabled: (document.querySelector('.settings-actions button') || {}).disabled,
});
"""

CLICK_SWITCH = r"""
const toggle = document.querySelector('.settings-switch input');
if (!toggle) return false;
toggle.click();
return !toggle.checked;
"""

CLICK_SAVE = r"""
const button = document.querySelector('.settings-actions button');
if (!button) return false;
button.click();
return true;
"""

CLICK_RESET = r"""
const button = document.querySelector('.settings-actions button.settings-secondary');
if (!button) return false;
button.click();
return true;
"""


def api_settings(app: str) -> dict:
    with urllib.request.urlopen(f"{app}/api/settings", timeout=15) as response:
        return json.load(response)


def wait_until(predicate, timeout: float, label: str, interval: float = 0.5):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        last = predicate()
        if last:
            return last
        time.sleep(interval)
    log(f"{label}: TIMED OUT (last={last!r})")
    return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--app", default="http://127.0.0.1:3000")
    args = parser.parse_args()

    failures: list[str] = []
    gecko = subprocess.Popen(
        ["geckodriver", "--port", str(GECKO_PORT)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, preexec_fn=os.setsid,
    )
    time.sleep(2)
    driver = WebDriver()
    try:
        # Start from a clean slate.
        request = urllib.request.Request(f"{args.app}/api/settings", method="DELETE")
        urllib.request.urlopen(request, timeout=15).read()

        driver.start()
        driver.get(args.app)
        time.sleep(8)

        log(f"panel toggle clicked: {driver.execute(PANEL_OPEN)}")

        def read_panel():
            state = json.loads(driver.execute(PANEL_STATE))
            # The panel renders before its settings fetch resolves; wait for content.
            return state if state.get("groups") else None

        state = wait_until(read_panel, 20, "settings panel")
        if not state:
            failures.append("the settings panel never rendered")
            raise SystemExit(1)

        log(f"panel state: {state}")
        for expected in ("VOICE PIPELINE", "IMAGE GENERATION", "DIRECTOR LLM", "SPEECH TO TEXT", "CLOUD KEY"):
            if expected not in state["groups"]:
                failures.append(f"missing settings section: {expected}")
        if state["imageryEnabled"] is not True:
            failures.append("image generation should start enabled")

        if not state["saveDisabled"]:
            failures.append("Save should be disabled until something changes")

        # Turn image generation off and save.
        driver.execute(CLICK_SWITCH)
        time.sleep(0.5)
        if driver.execute("return document.querySelector('.settings-actions button').disabled;"):
            failures.append("Save stayed disabled after toggling the switch")
        driver.execute(CLICK_SAVE)

        saved = wait_until(
            lambda: api_settings(args.app)["imagery"]["enabled"] is False,
            15, "imagery disabled on the server",
        )
        if not saved:
            failures.append("toggling the switch did not persist through the API")

        chip = wait_until(
            lambda: (lambda text: text if "IMAGES OFF" in text else None)(
                json.loads(driver.execute(PANEL_STATE))["chip"]
            ),
            15, "header reflects disabled imagery",
        )
        if not chip:
            failures.append("the header badge never showed IMAGES OFF")
        else:
            log(f"header chip: {chip.strip()}")

        # Restore the local defaults.
        driver.execute(CLICK_RESET)
        restored = wait_until(
            lambda: api_settings(args.app)["imagery"]["enabled"] is True,
            15, "imagery re-enabled after reset",
        )
        if not restored:
            failures.append("restore defaults did not re-enable image generation")

        shot = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs", "e2e-settings.png")
        os.makedirs(os.path.dirname(shot), exist_ok=True)
        driver.screenshot(shot)
        log(f"screenshot written to {shot}")
    finally:
        driver.quit()
        os.killpg(os.getpgid(gecko.pid), signal.SIGTERM)

    if failures:
        for failure in failures:
            log(f"FAIL: {failure}")
        return 1
    log("PASS: settings panel renders, saves, and resets")
    return 0


if __name__ == "__main__":
    sys.exit(main())
