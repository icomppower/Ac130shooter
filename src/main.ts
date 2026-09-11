import './style.css';
import {Game} from './game/Game';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
new Game(root);
