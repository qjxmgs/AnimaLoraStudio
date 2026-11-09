import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api } from '../../../../api/client'
import i18n from '../../../../i18n'
import { TrainDurationEstimate } from './TrainPlanPanel'

beforeEach(async () => {
  await i18n.changeLanguage('zh')
  vi.useFakeTimers()
  vi.spyOn(api, 'estimateTrainingDuration').mockResolvedValue({ seconds: null, task_ids: [] })
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
const settle = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(500) }) }

it('shows no estimate when history is absent', async () => {
  render(<TrainDurationEstimate config={{ epochs: 30 }} totalSteps={240} />)
  expect(screen.getByText('估算中…')).toBeInTheDocument()
  await settle()
  expect(screen.getByText('暂无估算')).toBeInTheDocument()
  expect(api.estimateTrainingDuration).toHaveBeenCalledWith({ epochs: 30 }, 240)
})
it('does not request a duration without a workload', async () => {
  render(<TrainDurationEstimate config={{}} totalSteps={null} />)
  await settle()
  expect(api.estimateTrainingDuration).not.toHaveBeenCalled()
  expect(screen.getByText('暂无估算')).toBeInTheDocument()
})
it('renders history-based minutes and distinguishes service errors', async () => {
  vi.mocked(api.estimateTrainingDuration).mockResolvedValueOnce({ seconds: 601, task_ids: [1, 2] })
  const page = render(<TrainDurationEstimate config={{}} totalSteps={240} />)
  await settle()
  expect(screen.getByText('约 11 分钟')).toBeInTheDocument()
  vi.mocked(api.estimateTrainingDuration).mockRejectedValueOnce(new Error('offline'))
  page.rerender(<TrainDurationEstimate config={{}} totalSteps={241} />)
  expect(screen.queryByText('约 11 分钟')).not.toBeInTheDocument()
  await settle()
  expect(screen.getByText('估算暂不可用')).toBeInTheDocument()
})
it('debounces changes and ignores outdated responses', async () => {
  let resolveOld!: (data: { seconds: number; task_ids: number[] }) => void
  vi.mocked(api.estimateTrainingDuration).mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
  const page = render(<TrainDurationEstimate config={{ epochs: 10 }} totalSteps={100} />)
  await settle()
  page.rerender(<TrainDurationEstimate config={{ epochs: 11 }} totalSteps={110} />)
  page.rerender(<TrainDurationEstimate config={{ epochs: 12 }} totalSteps={120} />)
  vi.mocked(api.estimateTrainingDuration).mockResolvedValueOnce({ seconds: 300, task_ids: [2] })
  await settle()
  await act(async () => resolveOld({ seconds: 900, task_ids: [1] }))
  expect(screen.getByText('约 5 分钟')).toBeInTheDocument()
  expect(api.estimateTrainingDuration).toHaveBeenCalledTimes(2)
})
