import { Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { MangaSeries } from '@shared/manga/model'
import { Notice } from '../../components/common/Notice'
import { Button, ConfirmDialog, Field, Group, Input, Row, Section, Segmented, Select, Switch, Textarea } from '../../components/ui'
import { useApp } from '../../store'
import { QUALITY_PRESETS, qualityFor, samplingForBundle } from '../studio/defaults'
import { installedBundles, resolveBundle } from '../studio/readiness'
import { readPreferredBundle } from './preferences'
import { AdapterEditor, useProviders } from './parts'
import type { SeriesUpdate } from './useSeries'

/** 设定: the series itself, the look every panel shares, and the language model the storyboard uses. */
export function SettingsTab({
  series,
  update,
  onDelete,
}: {
  series: MangaSeries
  update: SeriesUpdate
  onDelete: () => void
}): React.JSX.Element {
  const navigate = useNavigate()
  const catalog = useApp((state) => state.catalog)
  const { providers, loaded } = useProviders()
  const [confirming, setConfirming] = useState(false)
  const bundles = catalog ? installedBundles(catalog) : []
  const style = series.style
  const setStyle = (patch: Partial<MangaSeries['style']>): void =>
    update((current) => ({ ...current, style: { ...current.style, ...patch } }))
  const quality = qualityFor(style.steps)

  return (
    <div className="flex max-w-[760px] flex-col gap-8">
      <Section title="基本">
        <Field label="漫画名">
          <Input
            value={series.title}
            maxLength={120}
            onChange={(event) => update((current) => ({ ...current, title: event.target.value }))}
          />
        </Field>
        <Field label="简介" hint="一两句话说清楚故事，分镜时会告诉语言模型。">
          <Textarea
            rows={3}
            value={series.logline}
            onChange={(event) => update((current) => ({ ...current, logline: event.target.value }))}
          />
        </Field>
        <Field label="阅读方向">
          <Segmented
            className="self-start"
            label="阅读方向"
            value={series.readingDirection}
            onChange={(readingDirection) => update((current) => ({ ...current, readingDirection }))}
            options={[
              { value: 'rtl', label: '从右到左（日漫）' },
              { value: 'ltr', label: '从左到右（条漫、欧美）' },
            ]}
          />
        </Field>
      </Section>

      <Section title="画风" description="每一格都会带上这里的描述和 LoRA，让整部漫画看起来是同一个人画的。">
        <Field label="画风描述">
          <Textarea rows={3} value={style.prompt} onChange={(event) => setStyle({ prompt: event.target.value })} />
        </Field>
        <Field label="不想出现的内容">
          <Textarea rows={2} value={style.negative} onChange={(event) => setStyle({ negative: event.target.value })} />
        </Field>
        <Group>
          <Row title="成品为纯黑白" description="引擎偶尔会画出彩色，打开后预览和导出的页面一律转成黑白。">
            <Switch
              aria-label="成品为纯黑白"
              checked={Boolean(style.monochrome)}
              onCheckedChange={(monochrome) => setStyle({ monochrome })}
            />
          </Row>
        </Group>
        <AdapterEditor label="画风 LoRA" adapters={style.adapters} onChange={(adapters) => setStyle({ adapters })} />
        <div className="grid grid-cols-2 gap-4">
          <Field label="模型">
            <Select
              value={style.modelBundleId ?? ''}
              onValueChange={(id) => {
                // As in 创作: a few-step model brings its own steps and CFG, and leaving one restores 标准.
                const pick = (bundleId: string | undefined) => resolveBundle(catalog, bundleId, readPreferredBundle()).bundle
                const sampling = samplingForBundle(style, pick(style.modelBundleId), pick(id || undefined))
                setStyle({ modelBundleId: id || undefined, ...sampling })
              }}
              options={[
                { value: '', label: '和创作页一样' },
                ...bundles.map((bundle) => ({ value: bundle.id, label: bundle.name })),
                ...(style.modelBundleId && !bundles.some((bundle) => bundle.id === style.modelBundleId)
                  ? [{ value: style.modelBundleId, label: '已不在模型库里' }]
                  : []),
              ]}
            />
          </Field>
          <Field label="质量">
            <Select
              value={quality}
              onValueChange={(id) => {
                const preset = QUALITY_PRESETS.find((item) => item.id === id)
                if (preset) setStyle({ steps: preset.steps, cfg: preset.cfg })
              }}
              options={[
                ...QUALITY_PRESETS.map((preset) => ({ value: preset.id, label: `${preset.label} · ${preset.steps} 步` })),
                ...(quality === 'custom' ? [{ value: 'custom', label: `自定义 · ${style.steps} 步` }] : []),
              ]}
            />
          </Field>
        </div>
      </Section>

      <Section title="语言模型" description="把大纲拆成分镜、记下剧情，都由这里选的语言模型完成。">
        {loaded && !providers.length ? (
          <Notice
            tone="info"
            action={
              <Button size="xs" onClick={() => void navigate('/studio')}>
                去连接
              </Button>
            }
          >
            还没有连接语言模型。打开创作页右上角的「助手」，在「连接设置」里添加一个。
          </Notice>
        ) : (
          <Field label="用哪个语言模型">
            <Select
              value={providers.some((item) => item.id === series.providerId) ? series.providerId : ''}
              onValueChange={(providerId) => update((current) => ({ ...current, providerId: providerId || undefined }))}
              options={[
                { value: '', label: providers[0] ? `默认（${providers[0].name}）` : '默认' },
                ...providers.map((provider) => ({ value: provider.id, label: `${provider.name} · ${provider.model}` })),
              ]}
            />
          </Field>
        )}
      </Section>

      <Group>
        <Row title="删除这部漫画" description="人物卡、章节和参考图会一起删除，无法恢复。已经生成的图片仍保留在「作品」里。">
          <Button tone="ghost-danger" onClick={() => setConfirming(true)}>
            <Trash2 className="size-4" strokeWidth={1.6} /> 删除
          </Button>
        </Row>
      </Group>
      <ConfirmDialog
        open={confirming}
        title={`删除「${series.title}」？`}
        description="人物卡、章节、剧情记忆和参考图会永久删除。已经生成的图片仍保留在「作品」里。"
        confirmLabel="永久删除"
        onClose={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false)
          onDelete()
        }}
      />
    </div>
  )
}
