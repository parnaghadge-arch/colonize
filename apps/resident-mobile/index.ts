import { registerRootComponent } from 'expo';

import App from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App).
// It also ensures the environment is set up appropriately whether the app is
// loaded in Expo Go or in a native build.
registerRootComponent(App);
