// trace.c — mini-rv32ima.c (Charles Lohr, BSD/MIT/CC0) modified into a deterministic TRACE oracle
// for Bottle's lock-step test (tests/unit/lockstep.test.mjs).  The CPU core is the unmodified
// mini-rv32ima.h; only the harness around it changed:
//
//   * fixed (instruction-count) clock only — the `-l` mode of the original; `-t D` sets the divisor
//   * no stdin: IsKBHit() is always 0, so LSR reads 0x60 and RX reads 0
//   * no sleeping on WFI
//   * UART bytes are appended to trace.txt (`-u`), nothing is printed to stdout
//   * every K instructions (`-k`, default 4096) a snapshot of 42 little-endian uint32 words is
//     appended to trace.bin (`-o`):  pc, x0..x31, mstatus, mie, mip, mepc, mcause, mtval, mtvec,
//     mscratch, cycle_lo
//   * stops after N instructions (`-n`) or at poweroff
//   * the DTB is read from a file (`-b`, default ../images/default64mb.dtb) and then patched exactly
//     like the original patches its built-in copy (memory size := dtb_ptr, cmdline at +0xc0), because
//     that is what the JS Machine.loadDtb does
//   * the debug CSRs of the original harness are kept (the JS Machine implements them too): writes
//     to 0x136/0x137/0x138/0x139 print decimal / %08x / a NUL-terminated string / a char to the UART
//     stream, a read of 0x140 returns 0xffffffff (no keyboard); other unknown CSRs read 0
//
// ---------------------------------------------------------------------------------------------
// EXACT TIME SEMANTICS OF THE REFERENCE'S fixed_update MODE (what the JS 'fixed' clock reproduces)
// ---------------------------------------------------------------------------------------------
// The original main loop, with instrs_per_flip = B (1024, or 1 with -s) and time_divisor = D:
//
//   lastTime = 0
//   for (rt = 0; ...; rt += B) {
//     elapsedUs = cycle64 / D - lastTime;      // cycle64 = (cycleh<<32)|cyclel, integer division
//     lastTime += elapsedUs;                   // so lastTime == floor(cycle64 / D) after this line
//     ret = MiniRV32IMAStep(core, ram, 0, elapsedUs, B);
//     if (ret == 1) cycle64 += B;              // WFI: the core did not run; the idle batch is still
//                                              // counted as B cycles (and the original sleeps here)
//   }
//
// and inside MiniRV32IMAStep(elapsedUs, count = B), in this order:
//   1. timer += elapsedUs  (64-bit: timerl/timerh)   =>  timer == floor(cycle_at_batch_start / D)
//   2. if (timer > timermatch && timermatch != 0)  { clear WFI; mip.MTIP = 1 }  else  mip.MTIP = 0
//      NOTE: strictly greater (`>`), evaluated as a 64-bit compare of (timerh,timerl) vs match.
//   3. if WFI: return 1 (nothing else happens: no instruction, no cycle++)
//   4. if (mip.MTIP && mie.MTIE && mstatus.MIE): take the timer interrupt (mcause 0x80000007,
//      mtval 0, mepc = pc, pc = mtvec, mstatus = (MIE<<4 as MPIE) | (priv<<11), priv = M) and
//      execute NO instruction in this batch; cycle is not incremented.
//   5. else execute up to `count` instructions; cycle++ for each fetched instruction (the trapping
//      instruction is counted too); a trap ends the batch early (remaining slots are lost),
//      mepc = pc of the trapping instruction, mtval = address for load/store/AMO faults (codes
//      5, 7) and = pc for everything else (illegal instruction, ecall, ebreak, fetch fault).
//   6. a WFI instruction sets mstatus.MIE, sets the WFI flag, stores cycle and pc+4, returns 1.
//   7. a SYSCON store returns 0x5555/0x7777 immediately WITHOUT writing back cycle (so the
//      SYSCON store instruction is not counted) and with core->pc := core->pc + 4 (the pc saved at
//      the start of the batch, +4; with B = 1 that is the store's own pc + 4).
//
// Consequences for lock-step: the timer is sampled once per batch, at the batch start, from the
// instruction count; therefore the batch size B is part of the observable behaviour.  This tracer
// uses B = 1024 by default (`-B`), the reference's instrs_per_flip, which is also the JS core's
// cpu.batchSize: the JS samples mtime at the top of every 1024-instruction batch (or of the batch
// that follows one cut short by a trap / WFI / SYSCON), adds 1024 to the counter for every WFI
// return, and is driven by the lock-step test with cpu.stopOnFault = true in run(batchLeft ||
// batchSize) slices so that its batch boundaries are exactly the C's Step boundaries.  With `-B 1`
// the batch semantics collapse to the per-instruction semantics described in SPEC.md (which the
// JS reproduces with cpu.batchSize = 1).
//
// The rdcycle CSR (0xC00) returns the count INCLUDING the instruction currently executing (the
// core does cycle++ before the decode); cycleh (0xC80), time (0xC01) and timeh (0xC81) are not
// implemented by the core and read 0.
//
// Snapshots are written after every Step whose cycle64 crossed into a new multiple of K (with
// B = 1 that is exactly cycle64 == n*K; with B = 1024 it is the first batch end at or past n*K —
// the JS test mirrors this batch by batch).  The trailing partial K is never snapshotted.
//
// Build:  make -C ref      (gcc -O2 -I. trace.c -o trace)
// Run:    ./trace -f /tmp/linux.Image -n 30000000 -t 64 -B 1024 -k 4096 -o trace.bin -u trace.txt

#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

uint32_t ram_amt = 64*1024*1024;

static uint32_t HandleControlStore( uint32_t addy, uint32_t val );
static uint32_t HandleControlLoad( uint32_t addy );
static void HandleOtherCSRWrite( uint8_t * image, uint16_t csrno, uint32_t value );
static int32_t HandleOtherCSRRead( uint8_t * image, uint16_t csrno );
static int IsKBHit( void ) { return 0; }

#define MINIRV32WARN( x... ) fprintf( stderr, x );
#define MINIRV32_DECORATE  static
#define MINI_RV32_RAM_SIZE ram_amt
#define MINIRV32_IMPLEMENTATION
#define MINIRV32_POSTEXEC( pc, ir, retval ) { /* traps are handled by the core; nothing to do */ }
#define MINIRV32_HANDLE_MEM_STORE_CONTROL( addy, val ) if( HandleControlStore( addy, val ) ) return val;
#define MINIRV32_HANDLE_MEM_LOAD_CONTROL( addy, rval ) rval = HandleControlLoad( addy );
#define MINIRV32_OTHERCSR_WRITE( csrno, value ) HandleOtherCSRWrite( image, csrno, value );
#define MINIRV32_OTHERCSR_READ( csrno, value ) value = HandleOtherCSRRead( image, csrno );

#include "mini-rv32ima.h"

static uint8_t * ram_image = 0;
static struct MiniRV32IMAState * core;
static FILE * uart_out = 0;
static FILE * trace_out = 0;

static int64_t ReadNumber( const char * s, int64_t def )
{
	if( !s || !s[0] ) return def;
	char * end;
	long long v = strtoll( s, &end, 0 );
	return ( end == s ) ? def : v;
}

static long ReadFile( const char * name, uint8_t * dst, long maxlen )
{
	FILE * f = fopen( name, "rb" );
	if( !f ) { fprintf( stderr, "trace: cannot open \"%s\"\n", name ); exit( 5 ); }
	fseek( f, 0, SEEK_END );
	long len = ftell( f );
	fseek( f, 0, SEEK_SET );
	if( len > maxlen ) { fprintf( stderr, "trace: \"%s\" (%ld bytes) does not fit (%ld)\n", name, len, maxlen ); exit( 6 ); }
	if( len > 0 && fread( dst, len, 1, f ) != 1 ) { fprintf( stderr, "trace: short read on \"%s\"\n", name ); exit( 7 ); }
	fclose( f );
	return len;
}

static void PutU32( uint8_t * p, uint32_t v ) { p[0] = v; p[1] = v >> 8; p[2] = v >> 16; p[3] = v >> 24; }

#define SNAP_WORDS 42
static void WriteSnapshot( void )
{
	uint8_t buf[SNAP_WORDS * 4];
	int i, w = 0;
	PutU32( buf + 4 * w++, core->pc );
	for( i = 0; i < 32; i++ ) PutU32( buf + 4 * w++, core->regs[i] );
	PutU32( buf + 4 * w++, core->mstatus );
	PutU32( buf + 4 * w++, core->mie );
	PutU32( buf + 4 * w++, core->mip );
	PutU32( buf + 4 * w++, core->mepc );
	PutU32( buf + 4 * w++, core->mcause );
	PutU32( buf + 4 * w++, core->mtval );
	PutU32( buf + 4 * w++, core->mtvec );
	PutU32( buf + 4 * w++, core->mscratch );
	PutU32( buf + 4 * w++, core->cyclel );
	fwrite( buf, sizeof buf, 1, trace_out );
}

int main( int argc, char ** argv )
{
	int i;
	long long instct = 30000000;        // -n
	long long snap_every = 4096;        // -k
	int time_divisor = 1;               // -t
	int batch = 1024;                   // -B (the reference's instrs_per_flip)
	const char * image_file_name = 0;   // -f
	const char * dtb_file_name = "../images/default64mb.dtb"; // -b
	const char * cmdline = 0;           // -k is taken; use -c for the kernel command line
	const char * trace_name = "trace.bin"; // -o
	const char * uart_name = "trace.txt";  // -u
	int show_help = 0;

	for( i = 1; i < argc; i++ )
	{
		const char * p = argv[i];
		if( p[0] != '-' || !p[1] ) { show_help = 1; break; }
		const char * v = ( i + 1 < argc ) ? argv[i + 1] : 0;
		switch( p[1] )
		{
		case 'm': ram_amt = (uint32_t)ReadNumber( v, ram_amt ); i++; break;
		case 'n': instct = ReadNumber( v, instct ); i++; break;
		case 'k': snap_every = ReadNumber( v, snap_every ); i++; break;
		case 't': time_divisor = (int)ReadNumber( v, 1 ); i++; break;
		case 'B': batch = (int)ReadNumber( v, 1 ); i++; break;
		case 'f': image_file_name = v; i++; break;
		case 'b': dtb_file_name = v; i++; break;
		case 'c': cmdline = v; i++; break;
		case 'o': trace_name = v; i++; break;
		case 'u': uart_name = v; i++; break;
		default: show_help = 1; break;
		}
	}
	if( show_help || !image_file_name || time_divisor <= 0 || batch <= 0 || snap_every <= 0 )
	{
		fprintf( stderr, "usage: trace -f image [-b dtb] [-m ram] [-n instructions] [-t time_divisor] [-k snapshot_interval] [-B batch] [-c cmdline] [-o trace.bin] [-u trace.txt]\n" );
		return 1;
	}

	ram_image = calloc( ram_amt, 1 );
	if( !ram_image ) { fprintf( stderr, "trace: cannot allocate %u bytes\n", ram_amt ); return 4; }
	trace_out = fopen( trace_name, "wb" );
	uart_out = fopen( uart_name, "wb" );
	if( !trace_out || !uart_out ) { fprintf( stderr, "trace: cannot open output files\n" ); return 8; }

	ReadFile( image_file_name, ram_image, ram_amt );

	// DTB placement + patch, mirroring the original's handling of its built-in DTB.
	uint32_t dtb_ptr = 0;
	if( strcmp( dtb_file_name, "disable" ) != 0 )
	{
		FILE * f = fopen( dtb_file_name, "rb" );
		if( !f ) { fprintf( stderr, "trace: cannot open dtb \"%s\"\n", dtb_file_name ); return 5; }
		fseek( f, 0, SEEK_END );
		long dtblen = ftell( f );
		fclose( f );
		dtb_ptr = ram_amt - dtblen - sizeof( struct MiniRV32IMAState );
		ReadFile( dtb_file_name, ram_image + dtb_ptr, dtblen );
		if( cmdline ) strncpy( (char*)( ram_image + dtb_ptr + 0xc0 ), cmdline, 54 );
		uint32_t * dtb = (uint32_t*)( ram_image + dtb_ptr );
		if( dtb[0x13c/4] == 0x00c0ff03 )
		{
			uint32_t validram = dtb_ptr;
			dtb[0x13c/4] = (validram>>24) | ((( validram >> 16 ) & 0xff) << 8 ) | (((validram>>8) & 0xff ) << 16 ) | ( ( validram & 0xff) << 24 );
		}
	}

	core = (struct MiniRV32IMAState *)( ram_image + ram_amt - sizeof( struct MiniRV32IMAState ) );
	memset( core, 0, sizeof *core );
	core->pc = MINIRV32_RAM_IMAGE_OFFSET;
	core->regs[10] = 0x00;
	core->regs[11] = dtb_ptr ? ( dtb_ptr + MINIRV32_RAM_IMAGE_OFFSET ) : 0;
	core->extraflags |= 3;

	uint64_t lastTime = 0;
	uint64_t * this_ccount = (uint64_t*)&core->cyclel;
	uint64_t last_snap = 0;
	int exit_code = 0;
	for( ;; )
	{
		uint64_t before = *this_ccount;
		if( (long long)before >= instct ) break;
		uint32_t elapsedUs = (uint32_t)( before / time_divisor - lastTime );
		lastTime += elapsedUs;

		int ret = MiniRV32IMAStep( core, ram_image, 0, elapsedUs, batch );
		switch( ret )
		{
			case 0: break;
			case 1: *this_ccount += batch; break;   // WFI: idle tick(s), no sleep
			case 3: instct = 0; break;
			case 0x7777: fprintf( stderr, "REBOOT@%llu\n", (unsigned long long)*this_ccount ); exit_code = 0x77; goto done;
			case 0x5555: fprintf( stderr, "POWEROFF@%llu\n", (unsigned long long)*this_ccount ); exit_code = 0x55; goto done;
			default: fprintf( stderr, "trace: unknown step result %d\n", ret ); break;
		}
		uint64_t after = *this_ccount;
		if( after != before && after / snap_every != last_snap )
		{
			// With batch == 1 this is exactly cycle == n*K.  With batch > 1 the snapshot is taken at
			// the first batch end at or past the boundary; write one per crossed boundary.
			last_snap = after / snap_every;
			WriteSnapshot();
		}
	}
done:
	fclose( trace_out );
	fclose( uart_out );
	fprintf( stderr, "trace: stopped at cycle %llu, pc %08x\n", (unsigned long long)*this_ccount, core->pc );
	return exit_code;
}

static uint32_t HandleControlStore( uint32_t addy, uint32_t val )
{
	if( addy == 0x10000000 )
	{
		fputc( val & 0xff, uart_out );
	}
	else if( addy == 0x11004004 )
		core->timermatchh = val;
	else if( addy == 0x11004000 )
		core->timermatchl = val;
	else if( addy == 0x11100000 )
	{
		core->pc = core->pc + 4;
		return val;
	}
	return 0;
}

static uint32_t HandleControlLoad( uint32_t addy )
{
	if( addy == 0x10000005 )
		return 0x60 | IsKBHit();
	else if( addy == 0x10000000 && IsKBHit() )
		return 0;
	else if( addy == 0x1100bffc )
		return core->timerh;
	else if( addy == 0x1100bff8 )
		return core->timerl;
	return 0;
}

// The original harness's debug CSRs, redirected to the UART stream.
static void HandleOtherCSRWrite( uint8_t * image, uint16_t csrno, uint32_t value )
{
	if( csrno == 0x136 )
	{
		fprintf( uart_out, "%d", value );
	}
	if( csrno == 0x137 )
	{
		fprintf( uart_out, "%08x", value );
	}
	else if( csrno == 0x138 )
	{
		uint32_t ptrstart = value - MINIRV32_RAM_IMAGE_OFFSET;
		uint32_t ptrend = ptrstart;
		if( ptrstart >= ram_amt )
			fprintf( uart_out, "DEBUG PASSED INVALID PTR (%08x)\n", value );
		while( ptrend < ram_amt )
		{
			if( image[ptrend] == 0 ) break;
			ptrend++;
		}
		if( ptrend != ptrstart )
			fwrite( image + ptrstart, ptrend - ptrstart, 1, uart_out );
	}
	else if( csrno == 0x139 )
	{
		fputc( value & 0xff, uart_out );
	}
}

static int32_t HandleOtherCSRRead( uint8_t * image, uint16_t csrno )
{
	(void)image;
	if( csrno == 0x140 )
	{
		if( !IsKBHit() ) return -1;
		return 0;
	}
	return 0;
}
