import { styledTag, styleOfText } from '../../batch/edit/tagStyle'

// Prompt Lab's text has no tag style setting: a suggested tag is written the
// way the text it goes into already writes its tags (spaces when it says nothing).

export const writeLike = (text: string) => (tag: string): string => styledTag(tag, styleOfText(text))
