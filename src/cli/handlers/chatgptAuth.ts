/* eslint-disable custom-rules/no-process-exit -- CLI subcommand handler intentionally exits */
/**
 * Headless ChatGPT subscription OAuth — for programmatic hosts (e.g. TakoFlow
 * desktop UI) that need to drive the device-code flow without rendering the
 * REPL `/login` TUI.
 *
 * Wire format (line-delimited JSON on stdout):
 *
 *   { "type": "device_code", "verificationUrl": "https://auth.openai.com/codex/device", "userCode": "ABCD-1234" }
 *   { "type": "success", "tokenPath": "...openai-chatgpt-auth.json", "email": "...", "accountId": "..." }
 *   { "type": "error", "code": "timeout"|"denied"|"network"|"cancelled"|"unknown", "message": "..." }
 *
 * Exit codes: 0 = success, 1 = failure, 2 = user cancelled (SIGTERM/SIGINT).
 *
 * Token storage path respects CLAUDE_CONFIG_DIR (defaults to ~/.claude). Set
 * CLAUDE_CONFIG_DIR before spawning to isolate this login to a custom dir.
 */
import { homedir } from 'os'
import { join } from 'path'
import {
  completeChatGPTDeviceLogin,
  requestChatGPTDeviceCode,
} from '../../services/api/openai/chatgptAuth.js'

type ErrorCode = 'timeout' | 'denied' | 'network' | 'cancelled' | 'unknown'

type Event =
  | { type: 'device_code'; verificationUrl: string; userCode: string }
  | {
      type: 'success'
      tokenPath: string
      email?: string
      accountId?: string
    }
  | { type: 'error'; code: ErrorCode; message: string }

function emit(ev: Event): void {
  process.stdout.write(`${JSON.stringify(ev)}\n`)
}

/** Local JWT email extractor — avoids exporting internals from chatgptAuth.ts. */
function decodeJwtEmail(token: string | undefined): string | undefined {
  if (!token) return undefined
  try {
    const payload = token.split('.')[1]
    if (!payload) return undefined
    const norm = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = norm.padEnd(norm.length + ((4 - (norm.length % 4)) % 4), '=')
    const json = Buffer.from(padded, 'base64').toString('utf8')
    const claims = JSON.parse(json) as Record<string, unknown>
    const email = claims.email
    return typeof email === 'string' && email.length > 0 ? email : undefined
  } catch {
    return undefined
  }
}

/** Same path computation as chatgptAuth.ts authFilePath() — kept inline so we
 * don't have to alter the upstream module's export surface. */
function computeTokenPath(): string {
  const dir = (
    process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  ).normalize('NFC')
  return join(dir, 'openai-chatgpt-auth.json')
}

function classifyError(err: unknown): { code: ErrorCode; message: string } {
  const message = err instanceof Error ? err.message : String(err)
  const lower = message.toLowerCase()
  if (lower.includes('cancel')) return { code: 'cancelled', message }
  if (lower.includes('timed out') || lower.includes('timeout'))
    return { code: 'timeout', message }
  if (
    lower.includes('econnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('econnreset') ||
    lower.includes('network') ||
    lower.includes('fetch failed')
  )
    return { code: 'network', message }
  if (
    lower.includes('denied') ||
    lower.includes('forbidden') ||
    lower.includes('unauthorized')
  )
    return { code: 'denied', message }
  return { code: 'unknown', message }
}

export async function runChatGPTLoginCLI(): Promise<void> {
  const controller = new AbortController()
  let cancelledBySignal = false
  const onCancel = () => {
    cancelledBySignal = true
    controller.abort()
  }
  process.on('SIGTERM', onCancel)
  process.on('SIGINT', onCancel)

  try {
    const deviceCode = await requestChatGPTDeviceCode()
    emit({
      type: 'device_code',
      verificationUrl: deviceCode.verificationUrl,
      userCode: deviceCode.userCode,
    })

    const tokens = await completeChatGPTDeviceLogin(
      deviceCode,
      controller.signal,
    )

    emit({
      type: 'success',
      tokenPath: computeTokenPath(),
      email: decodeJwtEmail(tokens.idToken),
      accountId: tokens.accountId,
    })
    process.exit(0)
  } catch (err) {
    if (cancelledBySignal) {
      emit({ type: 'error', code: 'cancelled', message: 'user cancelled' })
      process.exit(2)
    }
    const { code, message } = classifyError(err)
    emit({ type: 'error', code, message })
    process.exit(1)
  }
}
