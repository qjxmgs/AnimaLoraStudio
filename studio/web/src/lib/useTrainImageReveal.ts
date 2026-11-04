import { useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../api/client'
import { useOptionalToast } from '../components/Toast'

export function useTrainImageReveal(projectId: number, versionId: number | null) {
  const { t } = useTranslation()
  const { toast } = useOptionalToast()
  const pending = useRef(false)
  return useCallback(async (path: string) => {
    if (!versionId || pending.current) return
    pending.current = true
    try {
      await api.revealTrainImage(projectId, versionId, path)
    } catch (error) {
      toast(error instanceof Error ? error.message : t('imageGrid.revealFailed'), 'error')
    } finally {
      pending.current = false
    }
  }, [projectId, versionId, toast, t])
}
