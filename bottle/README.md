# Bottle

**A whole Linux computer in one HTML file.**

Bottle is a RISC-V computer written from scratch in JavaScript — a 32-bit RV32IMA machine-mode CPU, RAM, a UART, a timer and a power controller — that boots a real, unmodified Linux 6.1 kernel with a Buildroot userland, inside a single self-contained web page. No server, no WebAssembly blobs, no network: the kernel images ship gzipped inside the page.

Open it and you get:

- **A terminal.** Log in as `root`, run `uname -a`, `cat /proc/cpuinfo`, write shell scripts. It is Linux.
- **DOOM.** The `emdoom` image renders the game into the terminal.
- **A live debugger.** Pause the kernel mid-flight and look at every register, single-step instructions, set breakpoints, disassemble around `pc`, hexdump and edit memory — the same machine, frozen.
- **An assembler.** Write RISC-V assembly in the page, assemble it, and run it bare-metal on the same CPU (a sample prints to the UART and powers the machine off).

## Is it correct?

Yes, provably: the machine model mirrors Charles Lohr's [mini-rv32ima](https://github.com/cnlohr/mini-rv32ima) (the C reference is vendored in `ref/`), and the test suite runs both emulators on the same kernel with a deterministic clock and compares **every register and CSR every 4,096 instructions for 30 million instructions**, plus byte-for-byte console output. On top of that: instruction-level tests written from the ISA specification, assembler/disassembler round trips, a Node boot-to-shell test, and Playwright tests that boot the page in a real browser and exercise the debugger.

## Run it

Open `dist/bottle.html`. Choose Linux, DOOM or Bare metal, press Boot.

## Develop

```
npm run build   # → dist/bottle.html
npm test        # unit tests, including the lock-step comparison against the C reference (needs gcc)
npm run e2e     # Playwright
npm run boot    # boot an image headlessly in Node and stream the console
```

The module contract is in [`SPEC.md`](SPEC.md).

## Credits

- Machine model and prebuilt images: [mini-rv32ima](https://github.com/cnlohr/mini-rv32ima) and [mini-rv32ima-images](https://github.com/cnlohr/mini-rv32ima-images) by Charles Lohr (MIT / BSD).
- Linux kernel (GPL-2.0) and Buildroot userland inside the images; DOOM via the emdoom port (GPL) — they run as guests and are not modified.
- Terminal: [xterm.js](https://xtermjs.org) (MIT).

Bottle's own code is MIT.
