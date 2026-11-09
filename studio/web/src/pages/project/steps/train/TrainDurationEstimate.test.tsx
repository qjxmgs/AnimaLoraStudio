import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api } from '../../../../api/client'
import i18n from '../../../../i18n'
import { TrainDurationEstimate } from './TrainPlanPanel'

beforeEach(async () => {
  localStorage.clear()
  await i18n.changeLanguage('zh')
  vi.useFakeTimers()
  vi.spyOn(api, 'estimateTrainingDuration').mockResolvedValue({ seconds: null, task_ids: [] })
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
const settle = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(500) }) }

it('remembers the entered speed across remounts and configuration changes until explicitly cleared', async () => {
  const page = render(<TrainDurationEstimate config={{ epochs: 30 }} totalSteps={240} />)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '0.50' } })
  expect(localStorage.getItem('train.estimateSpeed')).toBe('"0.50"')
  page.unmount()

  const reopened = render(<TrainDurationEstimate config={{ epochs: 60 }} totalSteps={480} />)
  expect(screen.getByRole('textbox')).toHaveValue('0.50')
  expect(screen.getByText('约 16 分钟')).toBeInTheDocument()
  await settle()
  expect(api.estimateTrainingDuration).not.toHaveBeenCalled()

  fireEvent.change(screen.getByRole('textbox'), { target: { value: '' } })
  reopened.unmount()
  render(<TrainDurationEstimate config={{ epochs: 30 }} totalSteps={240} />)
  expect(screen.getByRole('textbox')).toHaveValue('')
  await settle()
  expect(api.estimateTrainingDuration).toHaveBeenCalledWith({ epochs: 30 }, 240)
})

it('handles an unexpected stored speed type without crashing', async () => {
  localStorage.setItem('train.estimateSpeed', 'null')
  render(<TrainDurationEstimate config={{}} totalSteps={240} />)
  expect(screen.getByRole('textbox')).toHaveValue('')
  await settle()
  expect(screen.getByText('暂无估算')).toBeInTheDocument()
})

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


it('prioritizes manual speed, updates with steps, and restores history when cleared', async () => {
  vi.mocked(api.estimateTrainingDuration).mockResolvedValue({ seconds: 720, task_ids: [1] })
  const page = render(<TrainDurationEstimate config={{}} totalSteps={240} />)
  const input = screen.getByRole('textbox', { name: '速度（it/s）' })
  fireEvent.change(input, { target: { value: '0.50' } })
  expect(input).toHaveValue('0.50')
  expect(screen.getByText('约 8 分钟')).toBeInTheDocument()
  await settle()
  expect(api.estimateTrainingDuration).not.toHaveBeenCalled()
  page.rerender(<TrainDurationEstimate config={{}} totalSteps={480} />)
  expect(screen.getByText('约 16 分钟')).toBeInTheDocument()
  fireEvent.change(input, { target: { value: '' } })
  await settle()
  expect(screen.getByText('约 12 分钟')).toBeInTheDocument()
  expect(api.estimateTrainingDuration).toHaveBeenCalledWith({}, 480)
})
it('rejects zero, negative and non-finite manual speeds without silently using history', async () => {
  render(<TrainDurationEstimate config={{}} totalSteps={240} />)
  const input = screen.getByRole('textbox', { name: '速度（it/s）' })
  for (const value of ['0', '-1', 'abc', 'Infinity']) {
    fireEvent.change(input, { target: { value } })
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText('请输入大于 0 的有效速度')).toBeInTheDocument()
  }
  await settle()
  expect(api.estimateTrainingDuration).not.toHaveBeenCalled()
})
it('does not let a pending history response replace a manual estimate', async () => {
  let resolve!: (value: { seconds: number; task_ids: number[] }) => void
  vi.mocked(api.estimateTrainingDuration).mockImplementation(() => new Promise(r => { resolve = r }))
  render(<TrainDurationEstimate config={{}} totalSteps={240} />)
  await settle()
  fireEvent.change(screen.getByRole('textbox', { name: '速度（it/s）' }), { target: { value: '0.50' } })
  await act(async () => resolve({ seconds: 9999, task_ids: [1] }))
  expect(screen.getByText('约 8 分钟')).toBeInTheDocument()
})
