import { app } from './app';
import { env } from './shared/config/env';

app.listen(env.PORT, () => {
  console.log(`API listening on port ${env.PORT}`);
});