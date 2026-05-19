#!/usr/bin/env node
/**
 * One-shot multi-platform vendor setup for ripgrep.
 *
 * Companion to scripts/postinstall.cjs. postinstall downloads only the
 * current host's binary; this script populates all 6 platform subdirs in
 * src/utils/vendor/ripgrep/ so `npm publish` ships a tarball that works
 * on win / mac / linux × x64 / arm64.
 *
 * Idempotent — skips a platform if its binary already exists. Pass
 * --force to re-download everything.
 *
 * Source: microsoft/ripgrep-prebuilt (matches RG_VERSION from postinstall).
 *
 * Usage:
 *   node scripts/setup-all-platforms.cjs
 *   node scripts/setup-all-platforms.cjs --force
 *   RIPGREP_DOWNLOAD_BASE=<mirror-url> node scripts/setup-all-platforms.cjs
 */

const {
  existsSync,
  mkdirSync,
  rmSync,
  renameSync,
  statSync,
  writeFileSync,
  chmodSync,
} = require('fs')
const { spawnSync } = require('child_process')
const path = require('path')
const os = require('os')

// Keep in sync with scripts/postinstall.cjs.
const RG_VERSION = '15.0.1'

const DEFAULT_RELEASE_BASE = `https://github.com/microsoft/ripgrep-prebuilt/releases/download/v${RG_VERSION}`
const MIRROR_RELEASE_BASE = `https://ghproxy.net/https://github.com/microsoft/ripgrep-prebuilt/releases/download/v${RG_VERSION}`
const RELEASE_BASE = (
  process.env.RIPGREP_DOWNLOAD_BASE ?? DEFAULT_RELEASE_BASE
).replace(/\/$/, '')

const PLATFORMS = [
  { target: 'x86_64-pc-windows-msvc',    subdir: 'x64-win32',    binary: 'rg.exe', ext: 'zip' },
  { target: 'aarch64-pc-windows-msvc',   subdir: 'arm64-win32',  binary: 'rg.exe', ext: 'zip' },
  { target: 'x86_64-apple-darwin',       subdir: 'x64-darwin',   binary: 'rg',     ext: 'tar.gz' },
  { target: 'aarch64-apple-darwin',      subdir: 'arm64-darwin', binary: 'rg',     ext: 'tar.gz' },
  { target: 'x86_64-unknown-linux-musl', subdir: 'x64-linux',    binary: 'rg',     ext: 'tar.gz' },
  { target: 'aarch64-unknown-linux-gnu', subdir: 'arm64-linux',  binary: 'rg',     ext: 'tar.gz' },
]

const projectRoot = path.resolve(path.dirname(__filename), '..')
const vendorRoot = path.resolve(projectRoot, 'src', 'utils', 'vendor', 'ripgrep')

const force = process.argv.includes('--force')

async function downloadBuffer(url) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`)
  }
  return Buffer.from(await res.arrayBuffer())
}

async function downloadWithMirrors(assetName) {
  const candidates = [RELEASE_BASE]
  if (RELEASE_BASE === DEFAULT_RELEASE_BASE.replace(/\/$/, '')) {
    candidates.push(MIRROR_RELEASE_BASE.replace(/\/$/, ''))
  }

  let lastError
  for (const base of candidates) {
    const url = `${base}/${assetName}`
    try {
      return await downloadBuffer(url)
    } catch (err) {
      lastError = err
      console.warn(`  ! mirror failed: ${url} — ${err.message}`)
    }
  }
  throw lastError ?? new Error(`All mirrors failed for ${assetName}`)
}

function extractZip(buffer, destDir, binaryName) {
  const tmpDir = path.join(destDir, '.tmp-extract')
  rmSync(tmpDir, { recursive: true, force: true })
  mkdirSync(tmpDir, { recursive: true })
  try {
    const archivePath = path.join(tmpDir, 'archive.zip')
    writeFileSync(archivePath, buffer)

    let ok = false
    if (process.platform === 'win32') {
      const psCmd = `Expand-Archive -Path '${archivePath.replace(/'/g, "''")}' -DestinationPath '${tmpDir.replace(/'/g, "''")}' -Force`
      const result = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psCmd],
        { stdio: 'pipe', windowsHide: true }
      )
      ok = result.status === 0
    }

    if (!ok) {
      const result = spawnSync('unzip', ['-o', archivePath, '-d', tmpDir], { stdio: 'pipe' })
      ok = result.status === 0
      if (!ok) {
        const stderr = result.stderr?.toString().trim() || 'command not found'
        throw new Error(`zip extraction failed: ${stderr}`)
      }
    }

    const src = path.join(tmpDir, binaryName)
    if (!existsSync(src)) {
      throw new Error(`Binary ${binaryName} not found after extraction in ${tmpDir}`)
    }
    const dest = path.join(destDir, binaryName)
    renameSync(src, dest)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

function extractTarGz(buffer, destDir, binaryName) {
  const tmpDir = path.join(destDir, '.tmp-extract')
  rmSync(tmpDir, { recursive: true, force: true })
  mkdirSync(tmpDir, { recursive: true })
  try {
    const archiveName = 'archive.tar.gz'
    const archivePath = path.join(tmpDir, archiveName)
    writeFileSync(archivePath, buffer)
    // Run tar from inside tmpDir with a bare relative filename so Windows
    // GNU tar (MSYS / Git Bash) doesn't choke on "C:" or "\\" path parsing.
    const result = spawnSync('tar', ['-xzf', archiveName], {
      cwd: tmpDir,
      stdio: 'pipe',
      windowsHide: true,
    })
    if (result.status !== 0) {
      throw new Error(`tar extract failed: ${result.stderr?.toString().trim()}`)
    }
    const src = path.join(tmpDir, binaryName)
    if (!existsSync(src)) {
      throw new Error(`Binary ${binaryName} not found after extraction in ${tmpDir}`)
    }
    const dest = path.join(destDir, binaryName)
    renameSync(src, dest)
    chmodSync(dest, 0o755)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

async function setupPlatform(p) {
  const destDir = path.join(vendorRoot, p.subdir)
  const destBinary = path.join(destDir, p.binary)

  if (existsSync(destBinary) && !force) {
    const size = statSync(destBinary).size
    console.log(`✓ ${p.subdir}/${p.binary} already present (${(size / 1024 / 1024).toFixed(2)} MB) — skipped`)
    return
  }

  mkdirSync(destDir, { recursive: true })

  const assetName = `ripgrep-v${RG_VERSION}-${p.target}.${p.ext}`
  console.log(`→ ${p.subdir}: downloading ${assetName}`)

  const buffer = await downloadWithMirrors(assetName)

  if (p.ext === 'zip') {
    extractZip(buffer, destDir, p.binary)
  } else {
    extractTarGz(buffer, destDir, p.binary)
  }

  const size = statSync(destBinary).size
  console.log(`  ✓ ${p.subdir}/${p.binary} (${(size / 1024 / 1024).toFixed(2)} MB)`)
}

;(async () => {
  console.log(`Populating ${vendorRoot}`)
  console.log(`Source: ${RELEASE_BASE}`)
  console.log(`Version: ${RG_VERSION}`)
  if (force) console.log(`Mode: --force (re-download everything)`)
  console.log()

  for (const p of PLATFORMS) {
    try {
      await setupPlatform(p)
    } catch (err) {
      console.error(`✗ ${p.subdir} failed: ${err.message}`)
      process.exitCode = 1
    }
  }

  console.log()
  console.log('Done. Verify with: ls src/utils/vendor/ripgrep/*/')
})()
