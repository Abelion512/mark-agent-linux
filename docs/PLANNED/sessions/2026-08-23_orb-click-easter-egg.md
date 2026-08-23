# Session Log — 2026-08-23: orb click easter-egg clock

## Anti-Duplication Gate
- Grep git history: fitur clock orb sudah ada (bc5808d era, `merge-tmp-1787458024`) dengan bug race `clockPhase`. Bukan patch duplikat — ini perbaikan atas fitur yang sama.
- Patch serupa tidak ditemukan di branch lain.

## Masalah
1. Guard `document.fullscreenElement != null || !== undefined` selalu true/null-salah — logika salah; dan HTML5 fullscreen API tak dipakai Electron (pakai window maximize) → klik orb tak berefek.
2. `clockPhase` state machine di OrbVisualizer punya stale-closure race → clock hanya muncul sekali, orb tak kembali.
3. Jam kecil (`text-3xl`).

## Fix
- `MarkHome.jsx`: guard pakai `isMaxWindow`; state `easterEgg` + pool `EASTER_EGGS`; auto-hide 15s; klik lagi = hide.
- `OrbVisualizer.jsx`: hapus `clockPhase` + animasi exit; `text-5xl`.

## Gotcha sesi
- Fix pertama cuma mendarat di worktree `.claude/worktrees/fix-orb-click`, app jalan dari checkout utama → sync manual via `cp`.
- Push histori penuh ke GitHub ditolak GH001 (blob 260MB `tests/*.heapsnapshot`, venv). Solusi: branch mini 2-file (`pr-orb-fix-base` → `pr-orb-fix`).
- `.gitignore` di-harden (561d09d): `*.heapsnapshot`, `*.har`, `.venv/`, crash-config `electron.vite.config.*.mjs` di-untrack.

## Output
- Commit: `5009fd3` (fix orb), `561d09d` (.gitignore)
- PR: https://github.com/Abelion512/mark-agent-linux/pull/3
