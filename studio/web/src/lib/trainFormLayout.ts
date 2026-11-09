import type { ConfigData, SchemaResponse } from '../api/client'
import { evalShowWhen } from './schema'

export const TRAIN_GROUP_ORDER = [
  'model', 'dataset', 'lora', 'training', 'caption', 'system', 'output',
  'noise_augmentation', 'timestep_sampling', 'loss', 'sample', 'eval_validation', 'monitor',
]
export function trainSchemaGroups(schema: SchemaResponse, values: ConfigData) {
  const keys = new Set(Object.values(schema.schema.properties)
    .filter(prop => !prop.hidden && evalShowWhen(prop.show_when, values))
    .map(prop => prop.group ?? 'misc'))
  const groups = [...schema.groups]
  for (const key of keys) {
    if (!groups.some(group => group.key === key)) groups.push({ key, label: key })
  }
  return groups.filter(group => keys.has(group.key)).sort((a, b) => {
    const rank = (key: string) => {
      const index = TRAIN_GROUP_ORDER.indexOf(key)
      return index < 0 ? TRAIN_GROUP_ORDER.length : index
    }
    return rank(a.key) - rank(b.key)
  })
}
