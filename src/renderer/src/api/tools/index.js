import { core_tools } from './core-tools'
import { group_tools, group_tools_flat } from './group-tools'

export const checkTools = (toolName) => {
  return !!core_tools[toolName] || !!group_tools_flat[toolName] || toolName === 'read-tools'
}

export { core_tools, group_tools, group_tools_flat }
