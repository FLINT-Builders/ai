/**
 * Runs the docs MDX image pipeline (source.config.ts -> fumadocs-mdx preset ->
 * fumadocs-core remarkImage) against one local image URL.
 *
 * Prints READY after the preset is loaded and before the image is fetched, then
 * DONE if that transform returns. A crafted ICNS body keeps image-size 2.0.2
 * inside its ICNS parser, so DONE never arrives.
 */
import { remarkImage } from 'fumadocs-core/mdx-plugins';
import { applyMdxPreset } from 'fumadocs-mdx/config';
import config from '../source.config.ts';

const url = process.argv[2];

if (!url) {
  console.error('missing image url');
  process.exit(2);
}

function findRemarkImage(plugins) {
  if (!Array.isArray(plugins)) return undefined;
  for (const plugin of plugins) {
    if (plugin === remarkImage) return [remarkImage, {}];
    if (Array.isArray(plugin) && plugin[0] === remarkImage) return plugin;
  }
  return undefined;
}

const remarkImageOptions = config.mdxOptions?.remarkImageOptions;
const explicitlyDisabled =
  remarkImageOptions === false || remarkImageOptions?.external === false;

const mdxOptions = await applyMdxPreset(config.mdxOptions)('bundler');
const entry = findRemarkImage(mdxOptions.remarkPlugins);

if (!entry) {
  if (explicitlyDisabled) {
    process.stdout.write('READY\nDONE\n');
    process.exit(0);
  }
  console.error('remarkImage is not in the docs MDX preset');
  process.exit(2);
}

const [plugin, pluginOptions] = entry;
const transformer = plugin(pluginOptions);
const tree = {
  type: 'root',
  children: [
    {
      type: 'image',
      url,
      alt: 'remote',
    },
  ],
};
const file = {
  dirname: process.cwd(),
  path: 'probe.mdx',
  data: {},
};

process.stdout.write('READY\n');

try {
  await transformer(tree, file);
} catch (error) {
  console.error(
    error instanceof Error ? error.message : String(error),
  );
}

process.stdout.write('DONE\n');
process.exit(0);
