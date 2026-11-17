import { describe, expect, it } from 'vitest'
import {
  emptyHostForm,
  hostFormFrom,
  hostPathsPatch,
  hostSavePayload,
  parseSshCommand,
  validateHostForm,
} from '@renderer/pages/settings/hostForm'
import { sshHostFixture } from '@test/mocks/backend/fixtures'

describe('host form', () => {
  it('starts with the default remote folders and port', () => {
    const form = emptyHostForm()
    expect(form.port).toBe('22')
    expect(form.engineRoot).toBe('~/.mossstudio/engine')
    expect(form.authMethod).toBe('identityFile')
  })

  it('loads an existing host without its secrets', () => {
    const form = hostFormFrom(sshHostFixture({ hasPassword: true, authMethod: 'password', hasHfToken: true, downloadConcurrency: 3 }))
    expect(form).toMatchObject({
      id: 'ssh-gpu',
      host: 'gpu.example.test',
      user: 'moss',
      password: '',
      hasPassword: true,
      hfToken: '',
      hasHfToken: true,
      downloadConcurrency: '3',
    })
  })

  it('requires address and user, and a password for password login', () => {
    const errors = validateHostForm({ ...emptyHostForm(), authMethod: 'password' })
    expect(errors.host).toBe('地址不能为空')
    expect(errors.user).toBe('用户名不能为空')
    expect(errors.password).toBe('请输入 SSH 密码')
  })

  it('accepts a saved password and rejects bad values field by field', () => {
    const base = { ...emptyHostForm(), host: 'gpu.test', user: 'moss' }
    expect(validateHostForm(base)).toEqual({})
    expect(validateHostForm({ ...base, authMethod: 'password', hasPassword: true })).toEqual({})
    const errors = validateHostForm({
      ...base,
      host: 'gpu test',
      port: '70000',
      downloadProxy: 'ftp://x',
      hfEndpoint: 'nope',
      downloadConcurrency: '99',
      trainerRoot: '',
    })
    expect(Object.keys(errors).sort()).toEqual(['downloadConcurrency', 'downloadProxy', 'hfEndpoint', 'host', 'port', 'trainerRoot'])
  })

  it('builds the save payload with trimmed values and only the chosen secret', () => {
    const payload = hostSavePayload({
      ...emptyHostForm(),
      host: ' gpu.test ',
      user: ' moss ',
      port: '2222',
      identityFile: ' ~/.ssh/k ',
      password: 'ignored',
      downloadConcurrency: '',
    })
    expect(payload).toMatchObject({
      name: 'gpu.test',
      host: 'gpu.test',
      user: 'moss',
      port: 2222,
      identityFile: '~/.ssh/k',
      password: undefined,
      downloadConcurrency: null,
    })
    const withPassword = hostSavePayload({ ...emptyHostForm(), host: 'h', user: 'u', authMethod: 'password', password: 'pw' })
    expect(withPassword).toMatchObject({ password: 'pw', identityFile: undefined })
  })

  it('sends engine and output folders separately', () => {
    expect(hostPathsPatch('id', { ...emptyHostForm(), engineRoot: ' /opt/e ', outputRoot: '' })).toEqual({
      id: 'id',
      engineRoot: '/opt/e',
      outputRoot: undefined,
    })
  })

  describe('pasting an SSH command', () => {
    it('reads the port and user from a rental site login command', () => {
      expect(parseSshCommand('ssh -p 41234 root@connect.westb.example.com')).toEqual({
        host: 'connect.westb.example.com',
        user: 'root',
        port: '41234',
      })
      expect(parseSshCommand('  ssh -p41234 root@10.0.0.5  ')).toEqual({ host: '10.0.0.5', user: 'root', port: '41234' })
    })

    it('reads the key, -l and -o options and skips flags without a value', () => {
      expect(parseSshCommand('ssh -A -i "C:\\Users\\me\\.ssh\\id ed" -o Port=2200 -l ubuntu gpu.example.com nvidia-smi')).toEqual({
        host: 'gpu.example.com',
        user: 'ubuntu',
        port: '2200',
        identityFile: 'C:\\Users\\me\\.ssh\\id ed',
        authMethod: 'identityFile',
      })
      expect(parseSshCommand('ssh -o StrictHostKeyChecking=no -o User=moss host.test')).toEqual({ host: 'host.test', user: 'moss' })
    })

    it('reads ssh:// URLs, user@host:port and bracketed IPv6', () => {
      expect(parseSshCommand('ssh://root@host.test:2222')).toEqual({ host: 'host.test', user: 'root', port: '2222' })
      expect(parseSshCommand('root@host.test:2222')).toEqual({ host: 'host.test', user: 'root', port: '2222' })
      expect(parseSshCommand('ssh root@[2001:db8::1]:2222')).toEqual({ host: '2001:db8::1', user: 'root', port: '2222' })
      expect(parseSshCommand('ssh root@2001:db8::1')).toEqual({ host: '2001:db8::1', user: 'root' })
    })

    it('leaves a plain address, a half-typed command and other text alone', () => {
      expect(parseSshCommand('gpu.example.com')).toBeNull()
      expect(parseSshCommand('192.168.1.20')).toBeNull()
      expect(parseSshCommand('ssh -p 22')).toBeNull()
      expect(parseSshCommand('ssh')).toBeNull()
      expect(parseSshCommand('copy this: root@host')).toBeNull()
      expect(parseSshCommand('root@host:abc')).toBeNull()
    })
  })
})
