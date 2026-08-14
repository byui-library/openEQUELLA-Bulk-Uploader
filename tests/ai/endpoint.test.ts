import { describe, it, expect } from 'vitest';
import { isLoopbackEndpoint, isLoopbackHost } from '../../src/core/ai/endpoint.js';

describe('isLoopbackHost', () => {
  it('knows the names and addresses a model runtime actually listens on', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('LOCALHOST')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    // The whole /8, not just .0.1. Docker and some runtimes bind elsewhere in it.
    expect(isLoopbackHost('127.1.2.3')).toBe(true);
    expect(isLoopbackHost('127.255.255.255')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('[0:0:0:0:0:0:0:1]')).toBe(true);
    // RFC 6761 reserves the whole .localhost TLD for loopback.
    expect(isLoopbackHost('ollama.localhost')).toBe(true);
  });

  /**
   * The near-misses matter more than the hits. Each of these is a REMOTE host
   * that a loose check would wave through, and waving one through is what sends
   * a bearer key over plain http to somebody else's machine.
   */
  it('is not fooled by a host that merely looks local', () => {
    expect(isLoopbackHost('models.example.edu')).toBe(false);
    expect(isLoopbackHost('localhost.example.edu')).toBe(false);
    expect(isLoopbackHost('notlocalhost')).toBe(false);
    expect(isLoopbackHost('127.0.0.1.example.edu')).toBe(false);
    expect(isLoopbackHost('12.7.0.1')).toBe(false);
    expect(isLoopbackHost('1270.0.1')).toBe(false);
    // A private LAN address is not this machine. Another person's laptop is on it.
    expect(isLoopbackHost('192.168.1.10')).toBe(false);
    expect(isLoopbackHost('10.0.0.5')).toBe(false);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('')).toBe(false);
  });
});

describe('isLoopbackEndpoint', () => {
  it('reads the host out of a base url', () => {
    expect(isLoopbackEndpoint('http://localhost:11434/v1')).toBe(true);
    expect(isLoopbackEndpoint('http://127.0.0.1:1234/v1')).toBe(true);
    expect(isLoopbackEndpoint('http://[::1]:11434/v1')).toBe(true);
    expect(isLoopbackEndpoint('https://api.openai.com/v1')).toBe(false);
  });

  /**
   * An address that will not parse is not local. Answering "true" would exempt
   * a typo from the one check that stops a key crossing the network -- and this
   * function is read as "is this safe and free", so the unknown case must be
   * the cautious one.
   */
  it('treats an unparseable address as not local', () => {
    expect(isLoopbackEndpoint('not a url')).toBe(false);
    expect(isLoopbackEndpoint('')).toBe(false);
  });
});
