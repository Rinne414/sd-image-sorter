import type { zhCNPartialsB } from './zh-CN.partialsb'

export const enPartialsB: Record<keyof typeof zhCNPartialsB, string> = {
  // tag dialog: ready lists for the blacklist box
  'partialsb.bl.group': 'Ready-made blacklist lists',
  'partialsb.bl.quality': '+ Quality (masterpiece, score_*, …)',
  'partialsb.bl.qualityTip': 'Add the usual quality words (masterpiece, best quality, score_9_up and so on) to the blacklist; ones already there are not repeated',
  'partialsb.bl.meta': '+ Meta (signature, watermark, jpeg_artifacts, …)',
  'partialsb.bl.metaTip': 'Add signature, watermark and other marks on the picture itself (monochrome, sketch, censored and so on) to the blacklist; ones already there are not repeated',
  'partialsb.bl.clear': 'Clear',

  // Sort: already-sorted pictures
  'partialsb.sorted.leaveOut': 'Leave out pictures that are already sorted',
  'partialsb.sorted.tip': 'Pictures Auto-Separate or an earlier Manual Sort already copied or moved are not sorted again this time',
  'partialsb.sorted.counting': 'Counting what is already sorted…',
  'partialsb.sorted.none': 'None of these has been sorted yet.',
  'partialsb.sorted.left': '{n} of {total} already sorted, left out this time',
  'partialsb.sorted.included': '{n} of {total} already sorted, sorted again this time',
  'partialsb.sorted.allDone': 'All of these were already sorted. To sort them again, turn off “Leave out pictures that are already sorted”.',

  // queue sort: the menu
  'partialsb.sort.button': 'Sort',
  'partialsb.sort.working': 'Sorting…',
  'partialsb.sort.tip': 'Put the queue in groups by rating, aesthetic score, resolution or one of your saved profiles',
  'partialsb.sort.heading': 'Sort the queue',
  'partialsb.sort.rating': 'By rating',
  'partialsb.sort.aesthetic': 'By aesthetic score',
  'partialsb.sort.resolution': 'By resolution',
  'partialsb.sort.tooFew': 'The queue needs at least two pictures to sort.',
  'partialsb.sort.changed': 'The queue changed while sorting, so its order was left as it was. Sort again.',
  'partialsb.sort.done': 'Sorted: {name}.',
  'partialsb.sort.already': 'The queue is already in the order of “{name}”.',
  'partialsb.sort.failed': 'Could not sort: {reason}',

  // queue sort: the groups
  'partialsb.group.general': 'General',
  'partialsb.group.sensitive': 'Sensitive',
  'partialsb.group.questionable': 'Questionable',
  'partialsb.group.explicit': 'Explicit',
  'partialsb.group.unrated': 'Unrated',
  'partialsb.group.great': 'Great (7 and up)',
  'partialsb.group.good': 'Good (5 to 7)',
  'partialsb.group.low': 'Low (under 5)',
  'partialsb.group.unscored': 'No score',
  'partialsb.group.hd': 'Large (longer side 1920 or more)',
  'partialsb.group.sd': 'Smaller (longer side under 1920)',
  'partialsb.group.unknown': 'Size unknown',
  'partialsb.group.unsorted': 'In no group',

  // queue sort: the Order step's marks
  'partialsb.legend.title': 'Sort: {name}',
  'partialsb.legend.clear': 'Hide groups',

  // saved profiles
  'partialsb.profile.heading': 'My profiles',
  'partialsb.profile.none': 'No profiles saved yet',
  'partialsb.profile.manage': 'Manage profiles…',
  'partialsb.profile.title': 'Sort profiles',
  'partialsb.profile.help': 'A profile is a list of rules in order. Each picture goes to the first rule it matches; whatever matches none is put last, in a group of its own. Conditions are written the way the library search is.',
  'partialsb.profile.pick': 'Choose a profile',
  'partialsb.profile.new': 'New profile',
  'partialsb.profile.delete': 'Delete profile',
  'partialsb.profile.name': 'Profile name',
  'partialsb.profile.defaultName': 'My profile',
  'partialsb.profile.ruleName': 'Group {n}',
  'partialsb.profile.ruleLabel': 'Group name of rule {n}',
  'partialsb.profile.tone': 'Group colour',
  'partialsb.profile.condition': 'Condition of rule {n}',
  'partialsb.profile.conditionHint': 'Condition, e.g. tag:cat rating:general; empty means every picture',
  'partialsb.profile.removeRule': 'Remove rule {n}',
  'partialsb.profile.addRule': 'Add a rule',
  'partialsb.profile.rest': 'Pictures that match no rule go last.',
  'partialsb.profile.save': 'Save',
  'partialsb.profile.apply': 'Save and sort',
  'partialsb.profile.unsaved': 'Changes not saved yet',
  'partialsb.profile.unsavedWarn': 'Changes not saved yet. Press “Discard changes” to close anyway.',
  'partialsb.profile.discard': 'Discard changes',

  // group colours
  'partialsb.tone.gray': 'Gray',
  'partialsb.tone.green': 'Green',
  'partialsb.tone.gold': 'Warm',
  'partialsb.tone.red': 'Red',
  'partialsb.tone.light': 'Light',
}
