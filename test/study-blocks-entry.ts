// The study blocks (S6, S7) with the anchored ink and the content index, for the browser test
// test/run_study_blocks_test.py, as window.studyBlocks. Built by test/study-blocks-build.mjs.
import { createInkApi, flushInk } from '../src/study/ink';
import { buildIndex } from '../src/study/format/index-build';
import { mount as fog } from '../src/study/blocks/fog';
import { mount as drill } from '../src/study/blocks/drill';
import { mount as recall } from '../src/study/blocks/recall';
import { mount as problem, mountHook } from '../src/study/blocks/problem';
import { oldInkPass, register, PROBLEMS_DOC } from '../src/study/blocks/register';

(window as unknown as Record<string, unknown>).studyBlocks = { createInkApi, flushInk, buildIndex, fog, drill, recall, problem, mountHook, register, oldInkPass, PROBLEMS_DOC };
