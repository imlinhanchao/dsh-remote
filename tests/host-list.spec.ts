/** Extra remote host parsing: URL pastes, bare authorities, dedupe, junk. */
import { describe, expect, it } from 'vitest'
import { parseRemoteHosts } from '../src/host-list.ts'

describe('parseRemoteHosts', () => {
  it('accepts bare hosts, ports, and pasted URLs', () => {
    expect(parseRemoteHosts('dsh.example.com, 192.168.1.5:8080\nhttps://frp.example.com/path')).toEqual([
      'dsh.example.com',
      '192.168.1.5:8080',
      'frp.example.com',
    ])
  })

  it('dedupes, lowercases, and keeps IPv6 authorities', () => {
    expect(parseRemoteHosts('Example.com, example.com:443, [::1]:8443')).toEqual([
      'example.com',
      'example.com:443',
      '[::1]:8443',
    ])
  })

  it('ignores comments, blanks, and malformed entries', () => {
    expect(parseRemoteHosts('# a comment\n\nnot a host, http://, example.com:bad')).toEqual([])
  })

  it('returns an empty list for an empty setting', () => {
    expect(parseRemoteHosts(undefined)).toEqual([])
    expect(parseRemoteHosts('   ')).toEqual([])
  })
})
