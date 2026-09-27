# Builds the lock-step oracle (ref/trace) from the unmodified mini-rv32ima.h core.
CC ?= gcc
CFLAGS ?= -O2 -Wall -Wno-unused-function
trace: trace.c mini-rv32ima.h
	$(CC) $(CFLAGS) -I. -o $@ trace.c
clean:
	rm -f trace trace.bin trace.txt
.PHONY: clean
