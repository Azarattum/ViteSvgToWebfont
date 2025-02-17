import { promisify } from 'util';
import _webfontGenerator from '@vusion/webfonts-generator';
import { setupWatcher, MIME_TYPES, guid, ensureDirExistsAndWriteFile } from './utils';
import { parseOptions, parseFiles } from './optionParser';
import type { Plugin, ModuleGraph, ModuleNode } from 'vite';
import type { GeneratedFontTypes, WebfontsGeneratorResult } from '@vusion/webfonts-generator';
import type { IconPluginOptions } from './optionParser';
import type { GeneratedWebfont } from './types/generatedWebfont';
import type { PublicApi } from './types/publicApi';

const ac = new AbortController();
const webfontGenerator = promisify(_webfontGenerator);
const DEFAULT_MODULE_ID = 'vite-svg-2-webfont.css';

function getVirtualModuleId<T extends string>(moduleId: T): `virtual:${T}` {
    return `virtual:${moduleId}`;
}

function getResolvedVirtualModuleId<T extends string>(virtualModuleId: T): `\0${T}` {
    return `\0${virtualModuleId}`;
}

/**
 * A Vite plugin that generates a webfont from your SVG icons.
 *
 * The plugin uses {@link https://github.com/vusion/webfonts-generator/ webfonts-generator} package to create fonts in any format.
 * It also generates CSS files that allow using the icons directly in your HTML output, using CSS classes per-icon.
 */
export function viteSvgToWebfont<T extends GeneratedFontTypes = GeneratedFontTypes>(options: IconPluginOptions<T>): Plugin<PublicApi> {
    const processedOptions = parseOptions(options);
    let isBuild: boolean;
    let fileRefs: { [Ref in T]: string } | undefined;
    let _moduleGraph: ModuleGraph;
    let _reloadModule: undefined | ((module: ModuleNode) => void);
    let generatedFonts: undefined | Pick<WebfontsGeneratorResult<T>, 'generateCss' | 'generateHtml' | T>;
    const generatedWebfonts: GeneratedWebfont[] = [];
    const moduleId = options.moduleId ?? DEFAULT_MODULE_ID;
    const virtualModuleId = getVirtualModuleId(moduleId);
    const resolvedVirtualModuleId = getResolvedVirtualModuleId(virtualModuleId);

    const inline = <U extends string | undefined>(css: U) => {
        if (!options.inline) {
            return css;
        }
        return css?.replace(/url\(".*?\.([^?]+)\?[^"]+"\)/g, (_, type: T) => {
            const font = Buffer.from(generatedFonts?.[type] || []);
            return `url("data:${MIME_TYPES[type]};charset=utf-8;base64,${font.toString('base64')}")`;
        }) as U;
    };

    const generate = async (updateFiles?: boolean) => {
        if (updateFiles) {
            processedOptions.files = parseFiles(options);
        }
        if (isBuild) {
            processedOptions.writeFiles = false;
        }
        generatedFonts = await webfontGenerator(processedOptions);
        const hasFilesToSave = !processedOptions.writeFiles && (processedOptions.css || processedOptions.html);
        if (!isBuild && hasFilesToSave) {
            const promises: Promise<void>[] = [];
            if (processedOptions.css) {
                promises.push(ensureDirExistsAndWriteFile(inline(generatedFonts.generateCss()), processedOptions.cssDest));
            }
            if (processedOptions.html) {
                promises.push(ensureDirExistsAndWriteFile(generatedFonts.generateHtml(), processedOptions.htmlDest));
            }
            await Promise.all(promises);
        }
        if (updateFiles) {
            const module = _moduleGraph?.getModuleById(resolvedVirtualModuleId);
            if (module && _reloadModule) {
                _reloadModule(module);
            }
        }
    };
    return {
        name: 'vite-svg-2-webfont',
        enforce: 'pre',
        api: {
            getGeneratedWebfonts(): GeneratedWebfont[] {
                return generatedWebfonts;
            },
        },
        configResolved(_config) {
            isBuild = _config.command === 'build';
        },
        resolveId(id) {
            if (id !== virtualModuleId) {
                return undefined;
            }
            return resolvedVirtualModuleId;
        },
        transform(_code, id) {
            if (id !== resolvedVirtualModuleId) {
                return undefined;
            }
            return inline(generatedFonts?.generateCss?.(fileRefs)) || '';
        },
        load(id) {
            if (id !== resolvedVirtualModuleId) {
                return undefined;
            }
            return resolvedVirtualModuleId;
        },
        async buildStart() {
            if (!isBuild) {
                setupWatcher(options.context, ac.signal, () => generate(true));
            }
            await generate();
            if (isBuild && !options.inline) {
                const emitted = processedOptions.types.map<[T, string]>(type => [
                    type,
                    `/${this.getFileName(this.emitFile({ type: 'asset', fileName: `assets/${processedOptions.fontName}-${guid()}.${type}`, source: generatedFonts?.[type] }))}`,
                ]);

                emitted.forEach(([type, href]) => {
                    generatedWebfonts.push({ type, href });
                });
                fileRefs = Object.fromEntries(emitted) as { [Ref in T]: string };
            }
        },
        configureServer({ middlewares, reloadModule, moduleGraph }) {
            if (options.inline) {
                return;
            }
            for (const fontType of processedOptions.types) {
                const fileName = `${processedOptions.fontName}.${fontType}`;
                middlewares.use(`/${fileName}`, (_req, res) => {
                    _moduleGraph = moduleGraph;
                    _reloadModule = reloadModule;
                    if (!generatedFonts) {
                        res.statusCode = 404;
                        return res.end();
                    }
                    const font = generatedFonts[fontType];
                    res.setHeader('content-type', MIME_TYPES[fontType]);
                    res.setHeader('content-length', font.length);
                    res.statusCode = 200;
                    return res.end(font);
                });
            }
        },
        buildEnd() {
            ac.abort();
        },
    };
}
export default viteSvgToWebfont;
export { type GeneratedWebfont, type PublicApi };

/**
 * Paths of default templates available for use.
 */
export const templates = _webfontGenerator.templates;
