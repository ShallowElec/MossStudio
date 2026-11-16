/**
 * Why a training run failed, in words the person can act on, read from the last lines of its log.
 * The first rule (in this order) whose pattern appears anywhere in the tail wins: an out-of-memory
 * error usually drags a traceback with "not found" lines behind it, so the specific causes go first.
 */
const RULES: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /CUDA out of memory|OutOfMemoryError|CUBLAS_STATUS_ALLOC_FAILED|cudaErrorMemoryAllocation/i,
    reason: '显存不够。可以在「高级」里把分辨率调低，或选更小的显存档位，再重新开始。',
  },
  {
    pattern: /\bMemoryError\b|Cannot allocate memory|std::bad_alloc|DefaultCPUAllocator: can't allocate/i,
    reason: '内存不够。关掉一些程序，或在「高级」里把分辨率调低后再试。',
  },
  { pattern: /No space left on device|ENOSPC|Disk quota exceeded/i, reason: '磁盘空间不够了。清理出一些空间后再重新开始。' },
  {
    pattern:
      /no CUDA GPUs are available|CUDA driver version is insufficient|no kernel image is available|NVIDIA driver on your system is too old/i,
    reason: '没能用上显卡。请更新 NVIDIA 驱动后再试。',
  },
  {
    pattern: /ModuleNotFoundError|ImportError|is not recognized as an internal or external command|command not found/i,
    reason: '训练环境不完整。请在训练页重新准备环境后再试。',
  },
  {
    pattern: /Connection (?:closed|reset|refused|timed out)|Broken pipe|ssh: connect to host|Could not resolve hostname/i,
    reason: '和训练主机的连接断了。检查网络后重新开始。',
  },
  { pattern: /Permission denied|PermissionError|Access is denied/i, reason: '没有权限读写训练用到的文件夹。' },
  {
    pattern: /offline[- ]miss|not in the (?:latent|text) cache|cache miss/i,
    reason: '训练前的准备没有做完。请重新开始训练。',
  },
  {
    pattern: /FileNotFoundError|No such file or directory|does not exist|cannot find the (?:file|path)/i,
    reason: '训练要用的文件找不到了。请确认基础模型和图片都还在，再重新开始。',
  },
]

export const GENERIC_FAILURE = '训练中途出错了。可以在「任务」里查看日志，或重新开始。'

export function trainingFailureReason(lines: string[]): string {
  const text = lines.join('\n')
  return RULES.find((rule) => rule.pattern.test(text))?.reason ?? GENERIC_FAILURE
}
