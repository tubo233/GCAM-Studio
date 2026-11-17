import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import 'monaco-editor/esm/vs/editor/editor.all.js'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker.js?worker'
import 'monaco-editor/esm/vs/basic-languages/xml/xml.contribution.js'

// Ship the editor and worker with the app; XML editing also works offline.
;(self as any).MonacoEnvironment = { getWorker: () => new EditorWorker() }
loader.config({ monaco })
