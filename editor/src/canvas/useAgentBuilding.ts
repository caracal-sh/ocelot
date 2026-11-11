import { useSyncExternalStore } from 'react';
import type { Editor } from '../editor/Editor';
import { agentWorksOn } from './worldBox';

/** True while an agent is building the artboard (it holds a lock there, or its writing indicator rests on it). */
export function useAgentBuilding(editor: Editor, artboardId: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const offs = [editor.locks.subscribe(cb), editor.activity.subscribe(cb)];
      return () => offs.forEach((off) => off());
    },
    () => agentWorksOn(editor, artboardId),
  );
}
