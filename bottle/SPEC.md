# Bottle — a whole Linux computer in one HTML file

Bottle is a from-scratch **RISC-V (RV32IMA + Zicsr + M-mode) emulator in JavaScript** that boots a real Linux 6.1 kernel (and DOOM) inside a single self-contained HTML page: a terminal you can type into, a live debugger (registers, disassembly, memory, breakpoints, single-step), and an assembler so you can write your own bare-metal programs and run them on the same machine. Everything is inlined — the kernel images ship gzipped inside the page and are inflated with `DecompressionStream`.

This document is the binding contract between modules built by different authors. Deviate only with a `// SPEC DEVIATION:` comment that keeps the old behaviour working.

## Reference machine

We implement the machine model of `ref/mini-rv32ima.{c,h}` (Charles Lohr, MIT/BSD) exactly, so that its prebuilt images boot unchanged and so the C program can serve as a **lock-step oracle** in tests. Read both files fully before implementing anything. Key facts:

- RAM base `0x80000000`, size configurable (default 64 MiB = `0x4000000`). The kernel `Image` is loaded at RAM+0. The DTB (`images/default64mb.dtb`, 1536 bytes) is placed at `dtbAddr = ramSize − dtbLen − 192` (192 = sizeof the reference's core struct, which lives at the top of RAM in the reference — we reserve the same 192 bytes so addresses match). The DTB's `/memory` `reg` size is patched to the actual RAM size exactly as the reference does (it scans for the 32-bit big-endian value `0x00c00000`… see the C: it looks for the memory node's `reg` and writes `validram`). If a kernel command line is given, it is copied (≤ 54 bytes) at `dtbAddr + 0xc0`.
- Boot state: `pc = 0x80000000`, `x10 (a0) = 0` (hart id), `x11 (a1) = 0x80000000 + dtbAddr`, `extraflags = 3` (machine mode), all else 0.
- MMIO range `[0x10000000, 0x12000000)`:
  - UART (8250-ish): write byte to `0x10000000` → console output; read `0x10000005` (LSR) → `0x60 | (rxReady ? 1 : 0)`; read `0x10000000` → next input byte (or 0). No interrupts: the kernel polls.
  - CLINT: `0x1100bff8/0x1100bffc` mtime lo/hi (read); `0x11004000/0x11004004` mtimecmp lo/hi (read/write). Timer interrupt pending (`mip.MTIP`) when `mtime ≥ mtimecmp` (and mtimecmp ≠ 0 as in the reference: it checks `timermatch` non-zero); taken when `mstatus.MIE` and `mie.MTIE`; cause `0x80000007`.
  - SYSCON `0x11100000`: write `0x5555` → poweroff, `0x7777` → reboot.
  - Other MMIO reads return 0, writes are ignored.
- Time: the reference advances `mtime` from wall-clock microseconds (`time_divisor`), OR in `fixed_update` mode from the instruction count (`elapsed_us = instructionCount / time_divisor`). We support both: `clock: 'wall'` (default in the UI; `mtime` = microseconds since boot × speedFactor) and `clock: 'fixed'` (mtime = instructions / divisor — **deterministic**, used for lock-step tests).
- CSRs implemented exactly as the reference: `mstatus`, `mscratch`, `mtvec`, `mie`, `mip`, `mepc`, `mtval`, `mcause`, `cycle/cycleh` (= instruction count), `time/timeh` (= mtime), `misa` (`0x40401101`), `mvendorid` (`0xff0ff0ff`), `mhartid` (0), `pmpcfg*/pmpaddr*` read 0, unknown CSRs read 0 / writes ignored. `mret` restores privilege from `mstatus.MPP` and `MIE ← MPIE`. `wfi` sets `mstatus.MIE`, marks WFI, and the run loop returns. `ecall` from M-mode → cause 11, from U-mode → 8; `ebreak` → 3; illegal instruction → 2 with `mtval` = instruction; misaligned/out-of-range loads/stores → causes 5/7 (as the reference: load fault 5, store fault 7 with `mtval` = address) — the reference treats out-of-RAM non-MMIO accesses as access faults. Instruction fetch outside RAM → cause 1.
- Instructions: full RV32I, M (mul/mulh/mulhsu/mulhu/div/divu/rem/remu with RISC-V semantics for ÷0 and overflow), A (lr.w/sc.w with a single reservation, amoswap/add/xor/and/or/min/max/minu/maxu), Zicsr (csrrw/rs/rc + immediates), fence/fence.i (no-op), `mret`, `wfi`. Unaligned loads/stores must work (the reference allows them within RAM); LR/SC as in the reference (`extraflags` reservation address, sc succeeds iff the reservation matches).
- Traps: on a trap, `mepc = pc` of the faulting instruction (for interrupts: the next pc), `mstatus.MPIE ← MIE`, `MIE ← 0`, `MPP ← current privilege`, privilege ← M, `pc ← mtvec` (direct mode; the reference ignores vectored mode). Interrupts are checked once per instruction before execution (as the reference does at the top of its loop).

## Files and load order

```
bottle/
  images/linux-6.1.14.Image.gz   Linux 6.1.14 rv32 nommu + Buildroot userland (login: root, no password)
  images/doom.Image.gz           the emdoom image (DOOM in the terminal)
  images/default64mb.dtb         device tree (1536 bytes)
  ref/                           the C reference (read-only; the test author adds ref/trace.c + a Makefile beside it)
  src/cpu.js        RV.CPU        the core: decode/execute, CSRs, traps, run loop            (Node-loadable)
  src/machine.js    RV.Machine    RAM, MMIO devices, DTB placement, boot, snapshots, clocks (Node-loadable)
  src/disasm.js     RV.disasm     RV32IMA+Zicsr+priv disassembler                              (Node-loadable)
  src/asm.js        RV.asm        two-pass assembler with labels, pseudo-instructions, directives (Node-loadable)
  src/worker.js                   Web Worker entry: owns a Machine, runs it, message protocol below
  src/ui/terminal.js   UI.Terminal  xterm.js wrapper (input → worker, output ← worker)
  src/ui/debugger.js   UI.Debugger  registers, disassembly, memory, CSRs, breakpoints, stepping
  src/ui/app.js                     boot flow, image inflate, toolbar, assembler editor, status
  src/index.html, src/styles.css, src/ui/xterm.css (inlined)
  tools/build.mjs   → dist/bottle.html (+ dist/bottle.artifact.html)  — inlines CSS/JS, embeds images as base64 gzip
  tools/boot.mjs    Node CLI: boots an image headlessly, streams the console, reports MIPS
  tests/unit/*.test.mjs   node --test
  tests/e2e/*.spec.mjs    Playwright against dist/bottle.html
```

Every `src/*.js` core file is a plain script in an IIFE that attaches to `globalThis.RV` (same pattern as Skyward's `SW`), loadable in Node (`await import(...)` executes it) and in a Worker via `importScripts` or inlined text. `'use strict'`, no `console.log` in the build, typed arrays everywhere, zero allocation in the hot loop.

## `RV.CPU` (cpu.js)

```js
const cpu = new RV.CPU(bus);      // bus: { ram: Uint8Array, ram32: Uint32Array (same buffer), ramBase: 0x80000000, ramSize,
                                  //        mmioRead(addr) → uint32, mmioWrite(addr, value), readMtime() → [lo, hi] } — provided by Machine
cpu.regs      // Int32Array(32)  (x0 always 0 — enforce after every write)
cpu.pc        // uint32 (number)
cpu.csr       // { mstatus, mscratch, mtvec, mie, mip, mepc, mtval, mcause, cycle (BigInt or lo/hi pair — use two uint32 fields cyclel/cycleh) }
cpu.priv      // 3 = M, 0 = U   (the reference's extraflags & 3)
cpu.wfi       // boolean
cpu.reservation // uint32 or -1
cpu.instret   // number (instructions retired since reset; drives cycle CSR)
cpu.reset(pc, a0, a1)
cpu.step()           → 0 | trapCode   (executes exactly one instruction incl. interrupt check; returns a nonzero reason when the run loop must stop: 1 = wfi, 2 = poweroff/reboot signalled by the bus, 3 = breakpoint (set by cpu.breakpoints), 4 = fault stop (only when cpu.stopOnFault))
cpu.run(maxInstr)    → { executed, reason }   // tight loop; checks breakpoints only if cpu.hasBreakpoints; polls the timer every 64 instructions via bus.readMtime
cpu.breakpoints      // Uint8Array bitmap indexed by ((pc − ramBase) >> 2), lazily allocated; cpu.hasBreakpoints flag
cpu.setBreakpoint(addr, on)
cpu.trace            // optional hook: if set to a function it's called (pc, instr) before each instruction (disabled = null; must cost nothing when null: check once per run() call and use a separate loop)
```

Decoding: a single `switch (instr & 0x7f)` with nested switches; immediates computed with `| 0` arithmetic; use `Math.imul`, `>>>`, and a `Math.clz32`-free path. For loads/stores in RAM use the `Uint8Array`/`Uint32Array` directly (aligned word fast path: `(addr & 3) === 0 && inRange` → `ram32[(addr − base) >>> 2]`; otherwise assemble bytes). Target ≥ 40 MIPS in V8 on this box for the Linux boot (the C reference does ~150–250 MIPS; report what you get).

## `RV.Machine` (machine.js)

```js
const m = new RV.Machine({ ramSize: 64 << 20, clock: 'wall' | 'fixed', timeDivisor: 1 (fixed: µs per instruction = 1/divisor; the reference default divisor is 1 → mtime += 1 per instruction? — read the C: elapsed_us = instct / time_divisor; mtime += elapsed_us per outer loop), onConsole(byte), onPowerOff(reason) })
m.loadImage(uint8Array)               // copies to RAM+0
m.loadDtb(uint8Array, { cmdline })    // places, patches memory size, returns dtbAddr
m.boot({ image, dtb, cmdline })       // = reset + loadImage + loadDtb + cpu.reset(0x80000000, 0, ramBase+dtbAddr)
m.run(maxInstr)                       // advances mtime per its clock mode, runs the cpu, handles wfi (returns), returns { executed, reason: 'ok'|'wfi'|'poweroff'|'reboot'|'breakpoint'|'fault' }
m.input(byte | string)                // UART rx FIFO (Uint8Array ring, 4096)
m.cpu, m.ram, m.ram32, m.ramBase, m.ramSize
m.mtime()  → [lo, hi]                 // current mtime
m.snapshot() → { ram: Uint8Array copy, cpu state, devices }   // and m.restore(snap)
m.readWord(addr) / m.writeWord(addr, v) / m.read(addr, n) → Uint8Array (RAM or MMIO; used by the debugger)
```

Wall clock: on each `run()` call, `mtime = floor((performance.now() − t0) × 1000 × speed)` (µs), `speed` default 1 (UI can slow/speed the guest clock). Fixed clock: `mtime = floor(cpu.instret / timeDivisor)`. The reference's default `time_divisor` is 1 with wall time in µs; in fixed mode the reference's `-t` sets the divisor — the test author will pick a divisor and both sides must agree (document it in tests).

## `RV.disasm` (disasm.js)

`RV.disasm(instr /*uint32*/, pc /*uint32*/) → { text, mnemonic, kind: 'r'|'i'|'s'|'b'|'u'|'j'|'csr'|'amo'|'sys', target?: uint32 (branch/jump targets), rd, rs1, rs2, imm }` producing standard GNU objdump syntax with ABI register names (`ra, sp, gp, tp, t0–t6, s0/fp, s1–s11, a0–a7`) and pseudo-instruction folding (`nop`, `li`, `mv`, `not`, `neg`, `j`, `jr`, `ret`, `beqz/bnez/blez/bgez/bltz/bgtz`, `seqz/snez/sltz/sgtz`, `csrr/csrw/csrs/csrc` + immediates, `fence`, `unimp` for 0/0xc0001073). Compressed instructions are **not** implemented (the kernel is built without C — say so). `RV.disasmRange(machine, addr, count)`.

## `RV.asm` (asm.js)

`RV.asm.assemble(source, { base = 0x80000000 }) → { bytes: Uint8Array, symbols: {name: addr}, listing: [{addr, bytes, source, line}], errors: [{line, message}] }`. GNU-as-compatible subset: labels (`name:`, numeric `1:` with `1b/1f`), all RV32IMA/Zicsr instructions, pseudo-instructions (`li` with 32-bit immediates via `lui+addi`, `la` (PC-relative `auipc+addi`), `mv, not, neg, seqz, snez, j, jal label, jr, ret, call, tail, beqz…bgtz, csrr/csrw/csrs/csrc`), directives (`.text .data .word .half .byte .ascii .asciz .string .zero .align .globl .equ/.set .section`), `%hi(sym) %lo(sym) %pcrel_hi/%pcrel_lo` relocations, decimal/hex/char immediates, comments `#` and `//`. Must round-trip: `disasm(assemble(x))` reproduces objdump text for every instruction form (the test author checks).

## Worker protocol (worker.js ↔ ui/app.js)

Messages to the worker: `{type:'boot', image: ArrayBuffer (inflated), dtb, cmdline, ramSize, clock}`, `{type:'run'}`, `{type:'pause'}`, `{type:'step', n}`, `{type:'input', text}`, `{type:'setBreakpoint', addr, on}`, `{type:'read', addr, len, id}`, `{type:'write', addr, bytes}`, `{type:'state', id}` (registers+csrs+pc), `{type:'snapshot'}`, `{type:'restore'}`, `{type:'loadProgram', bytes, entry}` (bare-metal: RAM cleared, bytes at entry, pc=entry, no DTB), `{type:'setSpeed', factor}`.
From the worker: `{type:'console', bytes: Uint8Array}` batched ≤ 60 Hz, `{type:'status', running, mips, instret, uptimeUs, reason}` at 4 Hz, `{type:'state', id, pc, regs: Int32Array, csr: {...}, priv, wfi}`, `{type:'read', id, addr, bytes}`, `{type:'halted', reason}`, `{type:'booted'}`, `{type:'error', message}`.
The worker runs `machine.run(N)` in `setTimeout(0)`/`MessageChannel` slices of ~10 ms so messages stay responsive; while paused it services debugger requests only.

The worker is built from the same source files: `tools/build.mjs` concatenates `cpu.js + machine.js + disasm.js + worker.js` into a string that `app.js` turns into a `Blob` URL Worker (`new Worker(URL.createObjectURL(new Blob([src], {type:'text/javascript'})))`). Blob workers are allowed in the artifact host.

## UI (index.html, styles.css, ui/*.js)

**Identity.** A machine, not a website: near-black ground `#0B0C10`, panel `#12141B`, hairline `#232634`, text `#D9DCE3`, dim `#8B90A0`, phosphor accent `#F5B14C` (warm amber — the terminal's default foreground, cursor, active states), secondary `#5FD3A2` (mint — success, running), `#E36A5E` (fault/halt). Fonts: `JetBrains Mono` (Google Fonts) for everything monospace — terminal, registers, disassembly, hex — and `Inter Tight` for UI labels/headings. Tabular numerals. No rounded cards; flat panels with hairlines; 1px inset focus in amber.

**Layout.** Full viewport grid: 48px top bar (brand "Bottle", image picker select `#image-select` with Linux / DOOM / Bare metal, buttons `#btn-boot` Boot, `#btn-pause` Pause/Resume, `#btn-reset` Reset, status readout `#status` mono: `running · 62.4 MIPS · 1.24 s guest · 77.3M instr`, and `#btn-debug` toggling the debugger drawer). Main: the terminal `#terminal` (xterm, fit addon, fills the stage, amber-on-black theme, 15px font, cursor block). Right drawer `#debugger` (400px, collapsible; on phones a bottom sheet) with tabs: **Registers** (x0–x31 with ABI names, hex + signed decimal, changed values flash amber for 800 ms; pc, priv, mstatus/mie/mip/mtvec/mepc/mcause/mtval/mscratch, cycle, mtime), **Disassembly** (24 lines around pc — or a chosen address `#disasm-addr` input — with breakpoint gutter toggles, the current pc highlighted, branch targets shown, `Step` `#btn-step`, `Step 100`, `Run to cursor`), **Memory** (hexdump 16 bytes/row, 32 rows, `#mem-addr` goto, ASCII column, live refresh when paused, edit a byte by clicking), **Assembler** (a `<textarea id="asm-source">` with a sample program that prints to the UART and halts, `#btn-assemble` → listing with addresses/bytes/errors inline, `#btn-run-program` loads it bare-metal and runs; symbols list; errors highlight lines), **About** (what this is, the machine map, credits: mini-rv32ima by Charles Lohr (MIT/BSD), the Buildroot/Linux image, xterm.js (MIT); a note that DOOM is the emdoom port rendering to the terminal). Bottom status strip: boot progress (`inflating image… 3.4 MB`, `booting…` with the first kernel line), MIPS sparkline (canvas, last 60 s), guest uptime, `#hint`.

**Boot flow (app.js).** On load: create the worker, decode the selected image (base64 → gzip bytes → `DecompressionStream('gzip')` → ArrayBuffer; show progress), send `boot`, focus the terminal. Keyboard input from xterm → `input` (map Enter → `\r`, arrow keys → ANSI; xterm does that). Auto-login is off by default: the user types `root`. A "Type for me" toolbar chip `#btn-demo` runs a scripted demo (`root⏎`, `uname -a⏎`, `cat /proc/cpuinfo⏎`, `echo $((6*7))⏎`) with human-like pacing — for first-time viewers. Bare-metal mode: boot with no image, assembler tab open, sample program loaded.

**Performance.** The UI never blocks: console bytes are written to xterm in batches; the debugger polls `state` at 10 Hz while running (only when the drawer is open) and after every step/pause.

## Tests

- `tests/unit/cpu.test.mjs` — instruction-level tests written from the ISA spec (not from the implementation): every RV32I/M/A/Zicsr instruction with hand-computed expected results incl. edge cases (shift amounts masked to 5 bits, `sra` of negatives, `mulh*` sign combos, `div` by zero → −1 / `rem` by zero → dividend, `div` overflow `INT_MIN / −1`, `slt/sltu` boundaries, unaligned lw/sw in RAM, lr/sc success + failure after an intervening store, amo ops with negative values, csr set/clear masks, x0 writes ignored, `jalr` target LSB cleared, branch offsets negative). Trap tests: `ecall` sets mcause/mepc/mstatus and jumps to mtvec; `mret` restores; timer interrupt fires when `mtime ≥ mtimecmp` with MIE+MTIE; `wfi` returns from run; illegal instruction; load fault outside RAM. ≥ 120 assertions. Tests assemble the instructions with `RV.asm` where convenient but also include raw hand-encoded words for the encoder-independent cases.
- `tests/unit/disasm.test.mjs`, `tests/unit/asm.test.mjs` — encoder/decoder round trips for every instruction form + pseudo-instructions + relocations; a fixed table of `objdump`-style expected strings for ~60 words.
- `tests/unit/lockstep.test.mjs` — **differential test against the C reference**: `ref/trace.c` (a copy of mini-rv32ima.c with a `TRACE` mode: fixed clock with the chosen divisor, no sleeping, no stdin, and every K = 4096 instructions writes `pc` + 32 regs + `mstatus, mie, mip, mepc, mcause, mtval, mtvec, mscratch, cycle_lo` as little-endian uint32 to `ref/trace.bin`; also writes UART output to `ref/trace.txt`), built with `gcc -O2` by the test (skip with a message if gcc is absent) for the first 30 million instructions of the Linux boot. The JS machine runs the same configuration and must match **every** snapshot exactly and produce byte-identical UART output. This is the proof that the CPU is right.
- `tests/unit/boot.test.mjs` — boots Linux in Node with the wall clock, feeds `root\n`, `uname -a\n`, `echo $((6*7))\n`, `poweroff\n` when prompts appear, asserts `Linux buildroot 6.1.14`, `42`, and a clean `poweroff` return within 120 s; reports boot time and MIPS.
- `tests/e2e/bottle.spec.mjs` — Playwright: page loads with no console errors; boots to `buildroot login:` within 90 s (poll the terminal text via `term.buffer`… simpler: the app mirrors the last 4 KB of console text into a hidden `<pre id="console-mirror">` for tests); type `root` + `uname -a` and see `6.1.14`; open the debugger → Pause → registers show a nonzero pc, Step advances pc, set a breakpoint on the current pc + run → halts there; Memory shows the kernel's first bytes at `0x80000000`; assembler: sample program assembles with 0 errors and, run bare-metal, prints `Hello from bare metal` to the terminal; phone viewport: no horizontal overflow; DOOM boots and prints something (skip the game play).
