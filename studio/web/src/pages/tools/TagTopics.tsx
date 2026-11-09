import { useEffect, useMemo, useRef, useState } from 'react'
import Button from '../../components/Button'
import PageHeader from '../../components/PageHeader'
import { Input, Select, Textarea } from '../../components/FormControl'
import { useTagDict } from '../../tagDict/store'
import { explainTag, organizeTags } from '../../tagDict/organize'
import { reloadTopics, topicRequest, useTagTopics, type Topic, type TopicEntry, type TopicMatch } from '../../tagDict/topics'

const categories = ['作品', '角色', '人数与主体', '外貌', '服饰', '表情动作', '构图', '场景', '画质表现']
const sources: Record<string, string> = { builtin: '内置', user: '自定义', rule: '组合规则', fallback: '原有规则', unknown: '未识别', identity: '身份保护' }
const relations: Record<string, string> = { base: '基础词', variant: '词形变体', related: '主题相关', modifier: '修饰表达', exception: '例外', excluded: '排除归类', identity: '作品／角色保护', legacy: '原有保守规则', unknown: '保持原位' }
interface Result extends TopicMatch { zh: string; entry?: TopicEntry }
interface Transfer { format: 1; topics: Topic[]; entries: TopicEntry[] }
interface ImportPreview { conflicts: { type: string; key: string; local: unknown; incoming: unknown }[]; changes: { type: string; key: string }[]; applied: boolean }
const emptyEntry = (): TopicEntry => ({ tag: '', topic: '', base: false, excluded: false, relation: 'related', note: '' })

export default function TagTopicsPage() {
  const fileInput = useRef<HTMLInputElement>(null)
  const semantic = useTagTopics()
  const dict = useTagDict()
  const [q, setQ] = useState('')
  const [topic, setTopic] = useState('')
  const [rank, setRank] = useState('')
  const [source, setSource] = useState('')
  const [status, setStatus] = useState('')
  const [offset, setOffset] = useState(0)
  const [result, setResult] = useState<{ items: Result[]; total: number }>({ items: [], total: 0 })
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [entry, setEntry] = useState<TopicEntry | null>(null)
  const [customTopic, setCustomTopic] = useState<Topic | null>(null)
  const [raw, setRaw] = useState('')
  const [transfer, setTransfer] = useState<Transfer | null>(null)
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null)
  const [overwrite, setOverwrite] = useState(false)
  const [generation, setGeneration] = useState(0)
  const snapshot = semantic.snapshot
  const topics = snapshot?.topics ?? []
  const leaves = topics.filter((item) => item.kind === 'topic')
  const selectedTopic = topics.find((item) => item.id === topic)
  const path = (id?: string | null): string => {
    const found = topics.find((item) => item.id === id)
    if (!found) return '未明确归类'
    const names = [found.zh]
    let parent = found.parent
    const seen = new Set([found.id])
    while (parent && !seen.has(parent)) {
      seen.add(parent)
      const node = topics.find((item) => item.id === parent)
      if (!node) break
      names.unshift(node.zh); parent = node.parent
    }
    return `${categories[found.rank]} / ${names.join(' / ')}`
  }
  const chooseTopic = (id: string) => { setTopic(id); setQ(''); setOffset(0) }
  useEffect(() => {
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setLoading(true)
      const params = new URLSearchParams({ q, topic, source, status, offset: String(offset), limit: '50' })
      if (rank) params.set('rank', rank)
      topicRequest<{ items: Result[]; total: number }>(`/entries?${params}`, { signal: controller.signal })
        .then((value) => { if (!controller.signal.aborted) setResult(value) })
        .catch((e: unknown) => { if (!controller.signal.aborted) setError(String(e)) })
        .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    }, 180)
    return () => { clearTimeout(timer); controller.abort() }
  }, [q, topic, rank, source, status, offset, snapshot?.revision, generation])
  const run = async (operation: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('')
    try { await operation() } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  const refresh = async () => { await reloadTopics(true); setGeneration((value) => value + 1) }
  const preview = useMemo(() => {
    const tags = raw.split(/[,，\n]/).map((tag) => tag.trim()).filter(Boolean)
    return { before: tags, after: organizeTags(tags, dict.categories, snapshot), matches: tags.map((tag) => explainTag(tag, dict.categories, snapshot)) }
  }, [raw, dict.categories, snapshot])
  const detail = entry ? explainTag(entry.tag, dict.categories, snapshot) : null
  const detailTopic = topics.find((item) => item.id === detail?.topic)
  const detailRule = snapshot?.rules.find((rule) => rule.id === detail?.reason)
  const sameTopic = Object.values(snapshot?.entries ?? {}).filter((item) => item.topic && item.topic === detail?.topic)
  const exportData = async () => {
    const data = await topicRequest<Transfer>('/export')
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a'); link.href = url; link.download = 'tag-topic-overrides.json'; link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const newTopic = () => setCustomTopic({ id: 'user:', name: '', zh: '', rank: rank ? Number(rank) : 3, parent: null, group: '', kind: 'topic' })

  return <div className="min-w-0">
    <PageHeader title="本地主题词库" subtitle="查询、修正提示词归类。修改影响下次整理，不会自动改写训练标签。" actions={<>
      <Button onClick={() => void run(exportData)} disabled={busy}>导出修正</Button>
      <Button disabled={busy} onClick={() => fileInput.current?.click()}>导入修正</Button>
      <input ref={fileInput} type="file" aria-label="导入修正文件" accept=".json,application/json" disabled={busy} className="hidden" onChange={(event) => {
        const file = event.target.files?.[0]; event.target.value = ''
        if (!file) return
        void run(async () => {
          if (file.size > 10 * 1024 * 1024) throw new Error('导入文件不能超过 10MB')
          const data = JSON.parse(await file.text()) as Transfer
          const value = await topicRequest<ImportPreview>('/import', { method: 'POST', body: JSON.stringify(data) })
          setTransfer(data); setImportPreview(value); setOverwrite(false)
        })
      }} />
    </>} />
    <div className="px-page py-section flex flex-col gap-4 min-w-0">
    <p className="text-xs text-fg-tertiary">{leaves.length} 个具体主题 · {Object.keys(snapshot?.entries ?? {}).length} 条映射 · 修订 {snapshot?.revision ?? '—'} · 内置版本 {snapshot?.version ?? '—'}</p>
    {(error || semantic.error) && <div role="alert" className="text-warn">{error || semantic.error} {semantic.error && (snapshot ? '使用上次词库' : '整理预览暂用原有规则')} <Button size="sm" onClick={() => void run(refresh)}>重试</Button></div>}
    {notice && <p role="status" className="text-accent">{notice}</p>}
    {importPreview && transfer && <section className="border border-subtle rounded p-3 flex flex-col gap-2" aria-label="导入预览">
      <h2>导入预览：新增 {importPreview.changes.length} 项，冲突 {importPreview.conflicts.length} 项</h2>
      <div className="max-h-48 overflow-auto text-xs">
        {importPreview.changes.map((item) => <p key={`${item.type}:${item.key}`}>新增 {item.type}：{item.key}</p>)}
        {importPreview.conflicts.map((item) => <details key={`${item.type}:${item.key}`}><summary>冲突：{item.key}</summary><pre className="whitespace-pre-wrap">本地：{JSON.stringify(item.local, null, 2)}{'\n'}导入：{JSON.stringify(item.incoming, null, 2)}</pre></details>)}
      </div>
      <label><input type="checkbox" checked={overwrite} onChange={(event) => setOverwrite(event.target.checked)} /> 覆盖冲突项（默认保留本地）</label>
      <div className="flex gap-2"><Button disabled={busy} onClick={() => void run(async () => {
        await topicRequest(`/import?apply=true&overwrite=${overwrite}`, { method: 'POST', body: JSON.stringify(transfer) })
        await refresh(); setImportPreview(null); setTransfer(null); setNotice('导入完成')
      })}>确认导入</Button><Button onClick={() => { setImportPreview(null); setTransfer(null) }}>取消导入</Button></div>
    </section>}
    <div className="flex flex-col lg:flex-row gap-4 min-w-0">
      <aside className="lg:w-56 shrink-0 border border-subtle rounded p-2 max-h-[70vh] overflow-auto" aria-label="主题树">
        <Button size="sm" onClick={() => chooseTopic('')}>全部主题</Button>
        {categories.slice(2).map((label, index) => <details key={label} open><summary className="font-semibold text-sm py-1">{label}</summary>
          {topics.filter((item) => item.rank === index + 2 && item.kind === 'family').map((family) => <details key={family.id} className="ml-2">
            <summary className="text-sm cursor-pointer">{family.zh}</summary>
            <button className="block text-xs text-accent py-1" onClick={() => chooseTopic(family.id)}>查看此主题族</button>
            {leaves.filter((item) => item.parent === family.id).map((item) => <button key={item.id} onClick={() => chooseTopic(item.id)} aria-pressed={topic === item.id}
              className={`block w-full text-left text-sm px-2 py-1 rounded ${topic === item.id ? 'bg-accent-soft text-accent' : 'hover:bg-overlay'}`}>{item.zh}</button>)}
          </details>)}
          {leaves.filter((item) => item.rank === index + 2 && !item.parent).map((item) => <button key={item.id} className="block text-sm ml-2 py-1 text-accent" onClick={() => chooseTopic(item.id)}>{item.zh}</button>)}
        </details>)}
      </aside>
      <section className="flex-1 min-w-0 flex flex-col gap-3" aria-label="词条查询">
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-2">
          <Input aria-label="搜索主题词库" placeholder="英文、中文或主题名称…" value={q} onChange={(e) => { setQ(e.target.value); setOffset(0) }} />
          <Select aria-label="大类" value={rank} onChange={(e) => { setRank(e.target.value); setTopic(''); setOffset(0) }}><option value="">全部大类</option>{categories.map((label, i) => <option key={label} value={i}>{label}</option>)}</Select>
          <Select aria-label="来源" value={source} onChange={(e) => { setSource(e.target.value); setOffset(0) }}><option value="">全部来源</option>{Object.entries(sources).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select>
          <Select aria-label="归类状态" value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0) }}><option value="">全部状态</option><option value="mapped">已明确归类</option><option value="unmapped">未明确归类／候选</option></Select>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => setEntry(emptyEntry())}>新增词条</Button><Button onClick={newTopic}>新建主题</Button>
        </div>
        {topic && <div className="flex gap-2 items-center text-sm"><span>{path(topic)}</span><Button size="sm" onClick={() => chooseTopic('')}>清除主题筛选</Button>{selectedTopic?.source === 'user' && <Button size="sm" onClick={() => setCustomTopic(selectedTopic)}>编辑主题</Button>}</div>}
        <p role="status" className="text-xs text-fg-tertiary">{loading ? '查询中…' : `共 ${result.total} 条；候选仅供查询，不自动转为主题映射。`}</p>
        <div className="overflow-x-auto border border-subtle rounded">
          <table className="w-full text-sm"><thead><tr className="bg-overlay text-left"><th className="p-2">标签／翻译</th><th>主题路径</th><th>关系／来源</th><th>操作</th></tr></thead>
            <tbody>{result.items.map((item) => <tr key={item.tag} className="border-t border-subtle">
              <td className="p-2 break-words">{item.tag}<div className="text-xs text-fg-tertiary">{item.zh || dict.entries.get(item.tag)?.join(' ') || '—'}</div></td>
              <td className="p-2">{path(item.topic)}</td><td className="p-2">{relations[item.reason] ?? item.reason}<div className="text-xs text-fg-tertiary">{sources[item.source]}</div></td>
              <td className="p-2"><Button size="sm" onClick={() => setEntry(item.entry ?? { ...emptyEntry(), tag: item.tag, topic: item.topic ?? '' })}>查看／修正</Button></td>
            </tr>)}</tbody></table>
        </div>
        <div className="flex items-center gap-2"><Button disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - 50))}>上一页</Button><span>{Math.floor(offset / 50) + 1} / {Math.max(1, Math.ceil(result.total / 50))}</span><Button disabled={offset + 50 >= result.total || loading} onClick={() => setOffset(offset + 50)}>下一页</Button></div>
        {entry && <section aria-label="词条详情" className="border border-subtle rounded p-3 flex flex-col gap-2">
          <h2 className="font-semibold">词条详情与修正</h2>
          <Input aria-label="英文标签" value={entry.tag} onChange={(e) => setEntry({ ...entry, tag: e.target.value })} />
          <p className="text-xs">当前生效：{detail && `${sources[detail.source]} · ${relations[detail.reason] ?? detail.reason} · ${path(detail.topic)}`}</p>
          {detailRule && <p className="text-xs">组合规则：{detailRule.modifiers.join(' / ')} ＋ {detailRule.heads.join(' / ')}</p>}
          <Select aria-label="词条主题" value={entry.topic ?? ''} onChange={(e) => setEntry({ ...entry, topic: e.target.value })}><option value="">选择主题</option>{leaves.map((item) => <option key={item.id} value={item.id}>{path(item.id)}</option>)}</Select>
          <Select aria-label="关系类型" value={entry.relation} onChange={(e) => setEntry({ ...entry, relation: e.target.value as TopicEntry['relation'] })}>{['base','variant','related','modifier','exception'].map((key) => <option key={key} value={key}>{relations[key]}</option>)}</Select>
          <label><input type="checkbox" checked={Boolean(entry.base)} onChange={(e) => setEntry({ ...entry, base: e.target.checked })} /> 基础词优先</label>
          <label><input type="checkbox" checked={Boolean(entry.excluded)} onChange={(e) => setEntry({ ...entry, excluded: e.target.checked })} /> 排除自动归类，保持原位（作品／角色仍受身份保护）</label>
          <Input aria-label="来源或修正说明" placeholder="来源或修正说明" value={entry.note} onChange={(e) => setEntry({ ...entry, note: e.target.value })} />
          <div className="flex flex-wrap gap-2"><Button disabled={busy || !entry.tag.trim() || (!entry.excluded && !entry.topic)} onClick={() => void run(async () => { await topicRequest('/entries', { method: 'PUT', body: JSON.stringify(entry) }); await refresh(); setNotice('已保存修正，下次整理生效') })}>保存修正</Button>
            <Button disabled={busy} onClick={() => void run(async () => { await topicRequest(`/entries?tag=${encodeURIComponent(entry.tag)}`, { method: 'DELETE' }); await refresh(); setEntry(null); setNotice('已恢复内置归类') })}>恢复内置</Button><Button onClick={() => setEntry(null)}>关闭详情</Button></div>
          {detailTopic && <><p className="text-xs">同主题词（包括例外）：</p><div className="flex flex-wrap gap-2">{sameTopic.map((item) => <button key={item.tag} className="text-xs text-accent underline" onClick={() => setEntry(item)}>{item.tag}{item.relation === 'exception' ? '（例外）' : ''}</button>)}</div>
            <p className="text-xs">相关主题：</p><div className="flex flex-wrap gap-2">{leaves.filter((item) => item.id !== detailTopic.id && (item.parent === detailTopic.parent || item.group === detailTopic.group)).map((item) => <button key={item.id} className="text-xs text-accent underline" onClick={() => chooseTopic(item.id)}>{item.zh}</button>)}</div></>}
        </section>}
        {customTopic && <section aria-label="自定义主题" className="border border-subtle rounded p-3 flex flex-col gap-2"><h2>自定义主题</h2>
          <Input aria-label="主题 ID" value={customTopic.id} onChange={(e) => setCustomTopic({ ...customTopic, id: e.target.value })} placeholder="user:my-topic" />
          <Input aria-label="主题英文名称" value={customTopic.name} onChange={(e) => setCustomTopic({ ...customTopic, name: e.target.value })} />
          <Input aria-label="主题中文名称" value={customTopic.zh} onChange={(e) => setCustomTopic({ ...customTopic, zh: e.target.value })} />
          <Select aria-label="主题大类" value={customTopic.rank} onChange={(e) => setCustomTopic({ ...customTopic, rank: Number(e.target.value), parent: null, group: '' })}>{categories.slice(2).map((label, i) => <option key={label} value={i + 2}>{label}</option>)}</Select>
          <Select aria-label="父主题族" value={customTopic.parent ?? ''} onChange={(e) => setCustomTopic({ ...customTopic, parent: e.target.value || null })}><option value="">无父主题</option>{topics.filter((item) => item.kind === 'family' && item.rank === customTopic.rank).map((item) => <option key={item.id} value={item.id}>{item.zh}</option>)}</Select>
          <Select aria-label="排序聚合组" value={customTopic.group} onChange={(e) => setCustomTopic({ ...customTopic, group: e.target.value })}><option value="">独立成组</option>{[...new Set(leaves.filter((item) => item.rank === customTopic.rank).map((item) => item.group))].map((group) => <option key={group} value={group}>{group}</option>)}</Select>
          <div className="flex gap-2"><Button disabled={busy} onClick={() => void run(async () => { await topicRequest('/topics', { method: 'PUT', body: JSON.stringify({ ...customTopic, group: customTopic.group || customTopic.id }) }); await refresh(); setCustomTopic(null); setNotice('已保存主题') })}>保存主题</Button><Button onClick={() => setCustomTopic(null)}>取消</Button></div>
        </section>}
      </section>
    </div>
    <section aria-label="整理预览" className="border border-subtle rounded p-3 flex flex-col gap-2">
      <h2 className="font-semibold">整理预览（不修改训练数据）</h2>
      <Textarea aria-label="预览提示词" rows={3} value={raw} onChange={(e) => setRaw(e.target.value)} placeholder="large breasts, blue eyes, flat chest, breast, chest, long hair" />
      <p className="text-sm break-words">整理前：{preview.before.join(', ')}</p><p className="text-sm break-words" data-testid="organized-preview">整理后：{preview.after.join(', ')}</p>
      <div className="max-h-64 overflow-auto">{preview.matches.map((item, i) => <p key={i} className="text-xs py-1">{item.tag} → {item.topic ? path(item.topic) : item.rank !== undefined ? categories[item.rank] : '保持原位'} · {sources[item.source]} · {relations[item.reason] ?? item.reason}</p>)}</div>
    </section>
    </div>
  </div>
}
