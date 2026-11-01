#!/usr/bin/env python3
"""
theme-codemod.py  (step 1 of the Rands dark theme)

Replaces hardcoded colours in the ADMIN UI with named theme colours, so a second
theme can change them in one place. The current cream theme must look IDENTICAL
afterwards: every token's default value is the exact colour it replaces.

  python tools/theme-codemod.py            # rewrite files in place
  python tools/theme-codemod.py --check    # report only, change nothing

Scope: app/admin/**/*.{ts,tsx} and components/admin/**/*.{ts,tsx}.
Left alone ON PURPOSE: colours that are product data, not admin styling
(kiosk/display themes, brand presets, swatches, tenant colours, error-message
examples). Tailwind palette classes (stone-*, red-*, amber-*, emerald-*) are
also left alone: they are already CSS variables, so the dark theme retargets
them in one block (step 2).

Writes tools/theme-codemod-report.json: every replacement (file, old, new),
used by the verification script.
"""
import glob, json, re, sys

CHECK = "--check" in sys.argv
ROOTS = ("app/admin", "components/admin")

# --- which Tailwind utility prefixes mean text / background / border colour -----------
GROUP = {}
for p in ("text", "decoration", "placeholder", "fill", "stroke", "caret", "accent"): GROUP[p] = "text"
for p in ("bg", "from", "via", "to"): GROUP[p] = "bg"
for p in ("border", "border-t", "border-r", "border-b", "border-l", "border-x", "border-y",
          "divide", "ring", "ring-offset", "outline"): GROUP[p] = "border"

# --- (group, HEX) -> token.  HEX is upper-case without '#'. ---------------------------
MAP = {
    "text": {
        "1C1A17": "ink", "8A8375": "ink-muted", "6B6558": "ink-soft", "FAF6EE": "on-primary",
        "7A2E2E": "accent", "7A2E3A": "accent-alt", "4B6B54": "success", "9A6A12": "warn",
        "5C4A12": "warn-strong", "B3402A": "danger", "2557A7": "info", "2F5D2E": "success-strong",
    },
    "bg": {
        "1C1A17": "primary",            # solid; with an opacity suffix it becomes `ink` (a tint)
        "33302A": "primary-hover", "FAF6EE": "dialog", "FBF9F3": "panel", "FAF8F3": "canvas",
        "F3EEE2": "tint", "F1ECDF": "tint-2", "EDE8DA": "tint-3",
        "7A2E2E": "accent", "651F1F": "accent-hover", "662525": "accent-hover-2",
        "7A2E3A": "accent-alt", "651F2A": "accent-alt-hover",
        "4B6B54": "success", "3D5745": "success-hover",
        "9A6A12": "warn", "FBF3DC": "warn-soft", "FBF5E8": "warn-soft-2",
        "F3E3E0": "danger-soft", "B3402A": "danger", "2557A7": "info", "E1EDE0": "success-soft",
        "E6E1D4": "line", "D9D3C3": "line-strong",
    },
    "border": {
        "E6E1D4": "line", "D9D3C3": "line-strong", "7A2E2E": "accent", "7A2E3A": "accent-alt",
        "1C1A17": "ink", "4B6B54": "success", "9A6A12": "warn",
        "E3C98A": "warn-line", "E0B4AD": "danger-line",
    },
}

# Fixed light text on the tenant-coloured sidebar: it stays light in every theme.
LEAVE = {"components/admin/LogoutButton.tsx": {"FAF7F2", "C9B9BC"}}

UTIL = re.compile(
    r"(?P<prefix>border-[trblxy]|ring-offset|border|bg|text|ring|divide|outline|decoration|"
    r"placeholder|fill|stroke|from|via|to|accent|caret)-\[#(?P<hex>[0-9A-Fa-f]{6})\]"
    r"(?P<op>/(?:\[[\d.]+\]|\d+))?"
)
# whole-token rewrites (not hex): white as a card surface vs. white text on coloured buttons
EXACT = [
    (re.compile(r"(?<![\w/\[-])bg-white(?![\w/-])"), "bg-card"),
    (re.compile(r"(?<![\w/\[-])text-white(?![\w/-])"), "text-on-color"),
    (re.compile(r"(?<![\w/\[-])border-white(?![\w/-])"), "border-card"),
    (re.compile(r"(?<![\w/\[-])hover:bg-black(?![\w/-])"), "hover:bg-primary-hover-strong"),
]
# var(--sb-bg,#7A2E3A) style fallbacks inside Tailwind arbitrary values
FALLBACK = re.compile(r"var\((--sb-bg),#7A2E3A\)")

# BillingPanel keeps its colours in JS constants used only as inline-style values
CONST_FILE = "components/admin/BillingPanel.tsx"
CONSTS = {
    'const INK = "#1C1A17"': 'const INK = "var(--color-ink)"',
    'const MUTED = "#8A8375"': 'const MUTED = "var(--color-ink-muted)"',
    'const LINE = "#E6E1D4"': 'const LINE = "var(--color-line)"',
    'const ACCENT = "#7A2E2E"': 'const ACCENT = "var(--color-accent)"',
    'const SUCCESS = "#2B6F5C"': 'const SUCCESS = "var(--color-success-alt)"',
    'const AMBER = "#A66A1E"': 'const AMBER = "var(--color-warn-alt)"',
}
# ShiftsManager inline-style fallbacks
INLINE = {
    "app/admin/shifts/ShiftsManager.tsx": [
        ('tpl?.color ?? "#D9D3C3"', 'tpl?.color ?? "var(--color-line-strong)"'),
        (': "#F3EEE2" }}', ': "var(--color-tint)" }}'),
        ('t.color ?? "#F3EEE2"', 't.color ?? "var(--color-tint)"'),
        ("border border-[#D9D3C3]", "border border-line-strong"),
    ]
}

report, unmapped, changed_files = [], {}, 0
files = sorted(f for r in ROOTS for ext in ("ts", "tsx") for f in glob.glob(f"{r}/**/*.{ext}", recursive=True))

def repl_util(m, path):
    prefix, hx, op = m.group("prefix"), m.group("hex").upper(), m.group("op") or ""
    group = GROUP[prefix]
    token = MAP[group].get(hx)
    if group == "bg" and hx == "1C1A17" and op:
        token = "ink"                      # a translucent ink overlay is a tint, not the primary button
    if token is None and hx in LEAVE.get(path, ()):
        return m.group(0)
    if token is None:
        unmapped.setdefault(f"{prefix}-[#{hx}]", []).append(path)
        return m.group(0)
    new = f"{prefix}-{token}{op}"
    report.append({"file": path, "old": m.group(0), "new": new})
    return new

for path in files:
    src = open(path, encoding="utf-8").read()
    out = UTIL.sub(lambda m: repl_util(m, path), src)
    for rx, new in EXACT:
        def _r(m, rx=rx, new=new):
            report.append({"file": path, "old": m.group(0), "new": new}); return new
        out = rx.sub(_r, out)
    if FALLBACK.search(out):
        n = len(FALLBACK.findall(out))
        out = FALLBACK.sub(r"var(\1,var(--color-accent-alt))", out)
        report.append({"file": path, "old": "var(--sb-bg,#7A2E3A) x%d" % n, "new": "var(--sb-bg,var(--color-accent-alt)) x%d" % n})
    if path == CONST_FILE:
        for a, b in CONSTS.items():
            if a in out: out = out.replace(a, b); report.append({"file": path, "old": a, "new": b})
    for a, b in INLINE.get(path, []):
        if a in out: out = out.replace(a, b); report.append({"file": path, "old": a, "new": b})
    if out != src:
        changed_files += 1
        if not CHECK: open(path, "w", encoding="utf-8").write(out)

print(f"{'would change' if CHECK else 'changed'} {changed_files} files, {len(report)} replacements")
if unmapped:
    print("NOT MAPPED (left as-is):")
    for k, v in sorted(unmapped.items()): print("  ", k, "x%d" % len(v), sorted(set(v))[:3])
json.dump(report, open("tools/theme-codemod-report.json", "w"), indent=1)
