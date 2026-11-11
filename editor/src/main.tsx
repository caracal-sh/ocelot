// Standalone entry used by the Ocelot app and by `bun run dev` in a browser.
import { mountEditor } from './index';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');
mountEditor(root);
