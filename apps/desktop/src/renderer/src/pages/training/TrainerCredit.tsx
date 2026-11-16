import { ExternalLink } from 'lucide-react'
import { Ipc } from '@shared/channels'
import { call } from '../../lib/api'
import { cn } from '../../components/ui'

export const TRAINER_REPOSITORY = 'https://github.com/KohakuBlueleaf/KohakuMossTrainer'
export const TRAINER_LICENSE = `${TRAINER_REPOSITORY}/blob/main/LICENSE`

function Link({ url, children }: { url: string; children: string }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={() => void call(Ipc.openExternal, { url })}
      className="inline-flex items-center gap-0.5 rounded-sm align-baseline text-ink-2 underline underline-offset-2 hover:text-ink"
    >
      {children}
      <ExternalLink className="size-3" strokeWidth={1.6} aria-hidden="true" />
    </button>
  )
}

/** Who makes the trainer and under which license, on first use and in 设置 › 训练. */
export function TrainerCredit({ className }: { className?: string }): React.JSX.Element {
  return (
    <p className={cn('text-caption text-ink-2', className)} data-trainer-credit>
      Kohaku Trainer · <Link url={TRAINER_LICENSE}>KohakuMoss License 1.0</Link> · <Link url={TRAINER_REPOSITORY}>上游仓库</Link>
    </p>
  )
}
