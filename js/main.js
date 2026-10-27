import { Game } from './game.js';

const game = new Game();
window.__game = game;

game.init().catch((err) => {
  console.error(err);
  game.ui.loadError(err);
});
