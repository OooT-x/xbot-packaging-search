param(
  [int]$ListenMinutes = 60,
  [switch]$Once,
  [switch]$Voice,
  [ValidateSet("request", "both", "audio", "text")]
  [string]$VoiceMode = "request",
  [string]$VoiceId = "fast",
  [ValidateSet("auto", "deepseek", "ollama", "openai")]
  [string]$AiProvider = "auto",
  [string]$LocalModel = "qwen2.5:3b"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ScriptPath = Join-Path $ProjectRoot "bot\lark-bot-listener.js"
$DefaultRuntimeRoot = "C:\Users\ADMIN\Documents\飞书"
if (-not $env:LARK_BOT_RUNTIME_ROOT) {
  $env:LARK_BOT_RUNTIME_ROOT = if (Test-Path -LiteralPath $DefaultRuntimeRoot) {
    $DefaultRuntimeRoot
  } else {
    Join-Path $ProjectRoot "runtime"
  }
}
$RuntimeRoot = $env:LARK_BOT_RUNTIME_ROOT

if (-not $env:LARK_BOT_GROUP_CONTEXT_ALLOW_EXTERNAL_AI) {
  $UserGroupContextAllowExternalAi = [Environment]::GetEnvironmentVariable("LARK_BOT_GROUP_CONTEXT_ALLOW_EXTERNAL_AI", "User")
  if ($UserGroupContextAllowExternalAi) {
    $env:LARK_BOT_GROUP_CONTEXT_ALLOW_EXTERNAL_AI = $UserGroupContextAllowExternalAi
  }
}

if ($AiProvider -eq "deepseek" -and -not $env:LARK_BOT_GROUP_CONTEXT_ALLOW_EXTERNAL_AI) {
  $env:LARK_BOT_GROUP_CONTEXT_ALLOW_EXTERNAL_AI = "on"
}

if ($AiProvider -ne "auto") {
  $env:LARK_BOT_AI_PROVIDER = $AiProvider
}

if (-not $env:DEEPSEEK_API_KEY) {
  $UserDeepSeekApiKey = [Environment]::GetEnvironmentVariable("DEEPSEEK_API_KEY", "User")
  if ($UserDeepSeekApiKey) {
    $env:DEEPSEEK_API_KEY = $UserDeepSeekApiKey
  }
}

if (-not $env:LARK_BOT_SELF_OPEN_ID) {
  $LarkRun = Join-Path $env:APPDATA "npm\node_modules\@larksuite\cli\scripts\run.js"
  if (Test-Path -LiteralPath $LarkRun) {
    try {
      $AuthStatus = & node $LarkRun auth status --json --verify 2>$null | ConvertFrom-Json
      if ($AuthStatus.identities.bot.openId) {
        $env:LARK_BOT_SELF_OPEN_ID = $AuthStatus.identities.bot.openId
      }
    } catch {
      # Best effort only; missing this value just disables self-message filtering.
    }
  }
}

if ($Voice) {
  $env:LARK_BOT_VOICE = "on"
}

if (-not $env:LARK_BOT_VOICE_MODE) {
  $env:LARK_BOT_VOICE_MODE = $VoiceMode
}
if (-not $env:LARK_BOT_VOICE_ID) {
  $env:LARK_BOT_VOICE_ID = $VoiceId
}
if (-not $env:LARK_BOT_TTS_FORMAT) {
  $env:LARK_BOT_TTS_FORMAT = "opus"
}

if ($Voice -or -not $env:LARK_BOT_TTS_COMMAND) {
  $VoiceInstallRoot = if ($env:LARK_BOT_VOICE_INSTALL_ROOT) { $env:LARK_BOT_VOICE_INSTALL_ROOT } else { "D:\lark-voice-local" }
  $VoiceCacheRoot = Join-Path $VoiceInstallRoot "cache"
  if (-not $env:HF_HOME) {
    $env:HF_HOME = Join-Path $VoiceCacheRoot "huggingface"
  }
  if (-not $env:HUGGINGFACE_HUB_CACHE) {
    $env:HUGGINGFACE_HUB_CACHE = Join-Path $env:HF_HOME "hub"
  }
  if (-not $env:TRANSFORMERS_CACHE) {
    $env:TRANSFORMERS_CACHE = Join-Path $env:HF_HOME "transformers"
  }
  if (-not $env:TORCH_HOME) {
    $env:TORCH_HOME = Join-Path $VoiceCacheRoot "torch"
  }
  if (-not $env:NUMBA_CACHE_DIR) {
    $env:NUMBA_CACHE_DIR = Join-Path $VoiceCacheRoot "numba"
  }
  if (-not $env:TEMP -or $env:TEMP.StartsWith("C:\", [System.StringComparison]::OrdinalIgnoreCase)) {
    $env:TEMP = Join-Path $VoiceCacheRoot "tmp"
    $env:TMP = $env:TEMP
  }
  New-Item -ItemType Directory -Force -Path $env:NUMBA_CACHE_DIR, $env:TEMP | Out-Null
  $VoiceToolsRoot = Join-Path $VoiceInstallRoot "tools"
  if (Test-Path -LiteralPath $VoiceToolsRoot) {
    $VoiceToolDirs = Get-ChildItem -Path $VoiceToolsRoot -Recurse -Include sox.exe,ffmpeg.exe -File -ErrorAction SilentlyContinue |
      ForEach-Object { $_.DirectoryName } |
      Select-Object -Unique
    if ($VoiceToolDirs) {
      $env:PATH = ($VoiceToolDirs -join [IO.Path]::PathSeparator) + [IO.Path]::PathSeparator + $env:PATH
    }
  }

  $VoicePythonCandidates = @(
    $env:LARK_BOT_VOICE_PYTHON,
    (Join-Path $VoiceInstallRoot ".venv\Scripts\python.exe"),
    (Join-Path $RuntimeRoot "voice-local\.venv\Scripts\python.exe")
  ) | Where-Object { $_ }
  $VoicePython = $VoicePythonCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  $VoiceScript = Join-Path $RuntimeRoot "scripts\synthesize_qwen3_voice.py"
  $ElevenSongScript = Join-Path $RuntimeRoot "scripts\synthesize_eleven_music.py"
  if ($VoicePython -and (Test-Path -LiteralPath $VoiceScript)) {
    if (-not $env:LARK_BOT_TTS_COMMAND) {
      $env:LARK_BOT_TTS_COMMAND = $VoicePython
    }
    if (-not $env:LARK_BOT_TTS_ARGS) {
      $env:LARK_BOT_TTS_ARGS = '["./scripts/synthesize_qwen3_voice.py","--text-file","{textFile}","--output","{outputFile}","--voice-id","{voiceId}","--format","{format}"]'
    }
  }
  if ($VoicePython -and (Test-Path -LiteralPath $ElevenSongScript) -and $env:ELEVENLABS_API_KEY) {
    if (-not $env:LARK_BOT_SONG_COMMAND) {
      $env:LARK_BOT_SONG_COMMAND = $VoicePython
    }
    if (-not $env:LARK_BOT_SONG_ARGS) {
      $env:LARK_BOT_SONG_ARGS = '["./scripts/synthesize_eleven_music.py","--text-file","{textFile}","--output","{outputFile}","--voice-id","{voiceId}","--format","{format}"]'
    }
    if (-not $env:LARK_BOT_SONG_FORMAT) {
      $env:LARK_BOT_SONG_FORMAT = $env:LARK_BOT_TTS_FORMAT
    }
    if (-not $env:LARK_BOT_SONG_TIMEOUT_MS) {
      $env:LARK_BOT_SONG_TIMEOUT_MS = "300000"
    }
  }
}

if (-not $env:LARK_BOT_AI_PROVIDER -and $env:DEEPSEEK_API_KEY -and $env:LARK_BOT_AI -ne "off") {
  $env:LARK_BOT_AI_PROVIDER = "deepseek"
}

if ($env:LARK_BOT_AI_PROVIDER -eq "deepseek" -and $env:LARK_BOT_AI -ne "off") {
  if (-not $env:DEEPSEEK_BASE_URL) {
    $env:DEEPSEEK_BASE_URL = "https://api.deepseek.com"
  }
  if (-not $env:DEEPSEEK_MODEL -and -not $env:LARK_BOT_MODEL) {
    $env:DEEPSEEK_MODEL = "deepseek-v4-flash"
  }
  if (-not $env:LARK_BOT_AI_TIMEOUT_MS) {
    $env:LARK_BOT_AI_TIMEOUT_MS = "30000"
  }
  if (-not $env:DEEPSEEK_API_KEY) {
    Write-Warning "LARK_BOT_AI_PROVIDER=deepseek but DEEPSEEK_API_KEY is not set; smart replies will be disabled until a key is configured."
  }
}

if (-not $env:LARK_BOT_AI_PROVIDER -and $env:LARK_BOT_AI -ne "off") {
  $OllamaExe = "D:\Ollama\ollama.exe"
  if (Test-Path -LiteralPath $OllamaExe) {
    $env:LARK_BOT_AI_PROVIDER = "ollama"
    $env:OLLAMA_BASE_URL = "http://127.0.0.1:11434"
    if ($PSBoundParameters.ContainsKey("LocalModel") -or -not $env:LARK_BOT_MODEL) {
      $env:LARK_BOT_MODEL = $LocalModel
    }
    if (-not $env:LARK_BOT_AI_TIMEOUT_MS) {
      $env:LARK_BOT_AI_TIMEOUT_MS = "15000"
    }
    if (-not $env:LARK_BOT_MAX_OUTPUT_TOKENS) {
      $env:LARK_BOT_MAX_OUTPUT_TOKENS = "160"
    }
    if (-not $env:OLLAMA_MODELS) {
      $env:OLLAMA_MODELS = [Environment]::GetEnvironmentVariable("OLLAMA_MODELS", "User")
    }
    if (-not $env:OLLAMA_MODELS) {
      $env:OLLAMA_MODELS = "D:\OllamaModels"
    }

    try {
      Invoke-RestMethod -Uri "$env:OLLAMA_BASE_URL/api/version" -Method Get -TimeoutSec 3 | Out-Null
      $WarmupBody = @{
        model = $env:LARK_BOT_MODEL
        messages = @(@{ role = "user"; content = "ping" })
        stream = $false
        think = $false
        keep_alive = "30m"
        options = @{ num_predict = 1; temperature = 0 }
      } | ConvertTo-Json -Depth 6
      try {
        Invoke-RestMethod -Uri "$env:OLLAMA_BASE_URL/api/chat" -Method Post -Body $WarmupBody -ContentType "application/json; charset=utf-8" -TimeoutSec 30 | Out-Null
      } catch {
        Write-Warning "Ollama model warmup failed for ${env:LARK_BOT_MODEL}: $($_.Exception.Message)"
      }
    } catch {
      throw "Ollama is installed but its local service is not ready at $env:OLLAMA_BASE_URL"
    }
  }
}

$ArgsList = @($ScriptPath, "--listen-minutes", "$ListenMinutes")
if ($Once) {
  $ArgsList += "--once"
}

& node @ArgsList
