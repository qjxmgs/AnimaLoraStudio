export default function TopicLibraryLink({ error, cached }: { error?: string | null; cached?: boolean }) {
  return <span className="inline-flex flex-wrap items-center gap-1 text-xs">
    <a className="text-accent underline" href="/tools/tag-topics" target="_blank" rel="noopener noreferrer">主题词库</a>
    {error && <span role="status" className="text-warn" title={error}>
      {cached ? '词库更新失败，使用上次词库' : '词库不可用，使用原有整理规则'}
    </span>}
  </span>
}
