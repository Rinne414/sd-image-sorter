import type { MessageKey } from '../../../i18n'
import type { ExportProblem, LeftOutReason, OptionBlock } from './plan'
import type { IssueLabel } from './report'

// The words the export step uses for each rule, reason and backend issue.

export const BLOCK_KEY: Record<OptionBlock, MessageKey> = {
  package: 'dataset.export.block.package',
  beside: 'dataset.export.block.beside',
  move: 'dataset.export.block.move',
  folderImages: 'dataset.export.block.folderImages',
  copyNeeded: 'dataset.export.block.copyNeeded',
}

export const PROBLEM_KEY: Record<ExportProblem, MessageKey> = {
  noImages: 'dataset.export.problem.noImages',
  noFolder: 'dataset.export.problem.noFolder',
  mask: 'dataset.export.problem.mask',
  fixedNumbers: 'dataset.export.problem.fixedNumbers',
  bucketTrainer: 'dataset.export.block.package',
  bucketResolution: 'dataset.export.problem.bucketResolution',
  bucketOutput: 'dataset.export.block.move',
  watermarkTrainer: 'dataset.export.block.package',
  watermarkOutput: 'dataset.export.block.move',
  contractNone: 'dataset.export.problem.contract',
  contractMissing: 'dataset.export.problem.contract',
  trainerOutput: 'dataset.export.problem.trainerOutput',
  cropNotHere: 'dataset.export.problem.cropNotHere',
  cropFolderImages: 'dataset.export.block.folderImages',
  bucketFolderImages: 'dataset.export.block.folderImages',
  watermarkRegion: 'dataset.export.problem.watermarkRegion',
  maskMove: 'dataset.export.block.move',
  nlPackage: 'dataset.export.block.nlPackage',
}

export const LEFT_OUT_KEY: Record<LeftOutReason, MessageKey> = {
  changed: 'dataset.export.leftOut.changed',
  missing: 'dataset.export.leftOut.missing',
  gone: 'dataset.export.leftOut.gone',
  refused: 'dataset.export.leftOut.refused',
}

export const LABEL_KEY: Record<IssueLabel, MessageKey> = {
  unreadable: 'dataset.export.issue.unreadable',
  emptyCaption: 'dataset.export.issue.emptyCaption',
  renderFailed: 'dataset.export.issue.renderFailed',
  nameClash: 'dataset.export.issue.nameClash',
  existsSkipped: 'dataset.export.issue.existsSkipped',
  overwritesSource: 'dataset.export.issue.overwritesSource',
  duplicate: 'dataset.export.issue.duplicate',
  noMask: 'dataset.export.issue.noMask',
  nothingLeft: 'dataset.export.issue.nothingLeft',
  dialect: 'dataset.export.issue.dialect',
  multiline: 'dataset.export.issue.multiline',
  missingTrigger: 'dataset.export.issue.missingTrigger',
  ratings: 'dataset.export.issue.ratings',
  selection: 'dataset.export.issue.selection',
  other: 'dataset.export.issue.other',
}
