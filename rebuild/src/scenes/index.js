// Scene registry. Order here = order in the scroll stack.
import { createEntryScene } from './entry.js';
import { createIglooScene } from './igloo.js';
import { createCubesScene } from './cubes.js';

export const sceneFactories = [createEntryScene, createIglooScene, createCubesScene];
