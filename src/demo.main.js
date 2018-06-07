/**
 * A demo of the tendrils visuals - intro shot for a short film in the RTÉ Storyland series.
 */

/* global Map */

import glContext from 'gl-context';
import vkey from 'vkey';
import throttle from 'lodash/throttle';
import mapRange from 'range-fit';
import clamp from 'clamp';
import { mat3, vec2 } from 'gl-matrix';
import querystring from 'querystring';
import shader from 'gl-shader';
import prefixes from 'prefixes';
import xhr from 'xhr';
import toSource from 'to-source';

import dat from 'dat-gui';
// import dat from '../libs/dat.gui/build/dat.gui';

import { rootPath } from './utils/';
import redirect from './utils/protocol-redirect';

import Timer from './timer';

import { Tendrils, defaults, glSettings } from './';

import * as spawnPixels from './spawn/pixels';
import pixelsFrag from './spawn/pixels/index.frag';
import bestSampleFrag from './spawn/pixels/best-sample.frag';
import flowSampleFrag from './spawn/pixels/flow-sample.frag';
import dataSampleFrag from './spawn/pixels/data-sample.frag';

import spawnReset from './spawn/ball';

import Player from './animate';

import Screen from './screen';
import Blend from './screen/blend';
import screenVert from './screen/index.vert';
import blurFrag from './screen/blur.frag';
import OpticalFlow from './optical-flow';

import { curry } from './fp/partial';
import reduce from './fp/reduce';
import map from './fp/map';
import each from './fp/each';

toSource.defaultFnFormatter = (depth, f) => f.name;

export default (canvas, options) => {
    if(redirect()) {
        return;
    }

    const settings = Object.assign(querystring.parse(location.search.slice(1)),
        options);

    const defaultSettings = defaults();
    const defaultState = {
        ...defaultSettings.state,
        rootNum: Math.pow(2, 10)
    };

    Object.assign(defaultSettings.state, defaultState);


    // Main init

    const gl = glContext(canvas, glSettings, render);

    const timer = {
        app: defaultSettings.timer,
        media: new Timer(0)
    };


    // Tendrils init

    const tendrils = new Tendrils(gl, {
        ...defaultSettings,
        timer: timer.app,
        numBuffers: 1
    });

    /**
     * Stateful but convenient way to set which buffer we spawn into.
     * Set the properties to the targets used by the corresponding spawn
     * functions: to a buffer (e.g: `tedrils.targets`) to spawn into it; or
     * `undefined` to spawn into the default (the next particle step buffer).
     *
     * @type {Object.<(FBO|undefined)>}
     */
    const spawnTargets = {};

    const resetSpawner = spawnReset(gl);

    resetSpawner.shader.bind();


    // Some convenient shorthands

    const respawn = (buffer = spawnTargets.respawn) =>
        resetSpawner.spawn(tendrils, buffer);

    const reset = () => tendrils.reset();

    const restart = () => {
        tendrils.clear();
        respawn();
        respawn(tendrils.targets);
    };

    const clear = () => tendrils.clear();
    const clearView = () => tendrils.clearView();
    const clearFlow = () => tendrils.clearFlow();

    const state = tendrils.state;

    const appSettings = {
        animate: (''+settings.animate !== 'false'),
        videoURL: ((settings.video)?
                decodeURIComponent(settings.video)
            :   rootPath+'build/videos/morph.mp4')
    };

    if(''+settings.cursor === 'false') {
        canvas.classList.add('epok-no-cursor');
    }


    // Spawn feedback loop from flow
    /**
     * @todo The aspect ratio might be wrong here - always seems to converge on
     *       horizontal/vertical lines, like it were stretched.
     */

    const flowPixelSpawner = new spawnPixels.PixelSpawner(gl, {
            shader: [spawnPixels.defaults().shader[0], flowSampleFrag],
            buffer: tendrils.flow
        });

    const flowPixelScales = {
        'normal': [1, -1],
        // This flips the lookup, which is interesting (reflection)
        'mirror x': [-1, -1],
        'mirror y': [1, 1],
        'mirror xy': [-1, 1],
    };

    const flowPixelDefaults = {
        scale: 'normal'
    };

    const flowPixelState = { ...flowPixelDefaults };

    function spawnFlow(buffer = spawnTargets.spawnFlow) {
        vec2.div(flowPixelSpawner.spawnSize,
            flowPixelScales[flowPixelState.scale], tendrils.viewSize);

        flowPixelSpawner.spawn(tendrils, undefined, buffer);
    }


    // Spawn on fastest particles.

    const simplePixelSpawner = new spawnPixels.PixelSpawner(gl, {
        shader: [spawnPixels.defaults().shader[0], dataSampleFrag],
        buffer: null
    });

    function spawnFastest(buffer = spawnTargets.spawnFastest) {
        simplePixelSpawner.buffer = tendrils.particles.buffers[0];
        simplePixelSpawner.spawnSize = tendrils.particles.shape;
        simplePixelSpawner.spawn(tendrils, undefined, buffer);
    }


    // Media - video

    const imageShaders = {
        direct: shader(gl, spawnPixels.defaults().shader[0], pixelsFrag),
        sample: shader(gl, spawnPixels.defaults().shader[0], bestSampleFrag)
    };

    const imageSpawner = new spawnPixels.PixelSpawner(gl, { shader: null });

    // mat3.scale(imageSpawner.spawnMatrix,
    //     mat3.identity(imageSpawner.spawnMatrix), [-1, 1]);

    const rasterShape = {
        video: [0, 0]
    };

    const video = Object.assign(document.createElement('video'), {
        controls: true,
        muted: true,
        loop: true,
        // Autoplay causes the video to pause while offscreen in some browsers.
        autoplay: false,
        crossorigin: 'anonymous'
    });

    video.addEventListener('canplay', () => {
        rasterShape.video = [video.videoWidth, video.videoHeight];
        video.play();
    });

    const mediaSrc = (src = appSettings.videoURL) =>
        ((src.match(/^((https)?(:\/\/)?(www\.)?)drive\.google\.com\/(file\/d\/|open\?id\=)/gi))?
            // Handle Drive share links
            // https://drive.google.com/file/d/{ID}/view
            // https://drive.google.com/open?id={ID}
            src.replace(/^((https)?(:\/\/)?(www\.)?)drive\.google\.com\/(file\/d\/|open\?id\=)(.*?)(\/|\?|$).*?$/gi,
                    'https://drive.google.com/uc?export=&confirm=no_antivirus&id=$6')

        : ((src.match(/^(https)?(:\/\/)?(www\.)?dropbox\.com\/s\//gi))?
            // Handle Dropbox share links
            // https://www.dropbox.com/s/{ID}?dl=0
            // https://www.dropbox.com/sh/{ID}?dl=0
            src.replace(/^((https)?(:\/\/)?(www\.)?)dropbox\.com\/sh?\/(.*)\?.*$/gi,
                    'https://dl.dropboxusercontent.com/s/$5?dl=1&raw=1')
            // Plain URLs otherwise - and handle falsey.
        :   src || ''));

    video.src = mediaSrc();
    document.body.appendChild(video);


    function spawnRaster(shader, speed, buffer) {
        imageSpawner.shader = shader;
        imageSpawner.speed = speed;

        const shape = rasterShape.video;
        const raster = video;

        if(Math.max(...shape) > 0) {
            imageSpawner.buffer.shape = tendrils.colorMap.shape = shape;

            try {
                imageSpawner.setPixels(raster);
            }
            catch(e) {
                console.warn(e);
            }

            imageSpawner.spawn(tendrils, undefined, buffer);
        }
    }

    const spawnImage = (buffer = spawnTargets.spawnImage) =>
        spawnRaster(imageShaders.direct, 0.3, buffer);

    const spawnSamples = (buffer = spawnTargets.spawnSamples) =>
        spawnRaster(imageShaders.sample, 1, buffer);


    // Optical flow

    const opticalFlow = new OpticalFlow(gl, undefined, {
        speed: parseFloat(settings.optical_speed || 0.08, 10),
        offset: 0.1
    });

    const opticalFlowState = {
        speed: opticalFlow.uniforms.speed,
        lambda: opticalFlow.uniforms.lambda,
        offset: opticalFlow.uniforms.offset
    };

    const opticalFlowDefaults = { ...opticalFlowState };


    // Color map blending

    const blend = new Blend(gl, {
        views: [opticalFlow.buffers[0]],
        alphas: [0.8]
    });


    // Screen effects

    const screen = new Screen(gl);


    // Blur vignette

    const blurShader = shader(gl, screenVert, blurFrag);

    const blurDefaults = {
        radius: 3,
        limit: 0.5
    };

    const blurState = { ...blurDefaults };
    // const blurState = {
    //     radius: 8,
    //     limit: 0.2
    // };

    blurShader.bind();
    Object.assign(blurShader.uniforms, blurState);


    // Background

    function toggleBase(background) {
        if(!background) {
            background = ((canvas.classList.contains('epok-dark'))? 'light' : 'dark');
        }

        canvas.classList.remove('epok-light');
        canvas.classList.remove('epok-dark');

        canvas.classList.add('epok-'+background);
    }


    // Animation setup

    const tracks = {
        tendrils: tendrils.state,
        tendrils2: tendrils.state,
        tendrils3: tendrils.state,
        baseColor: tendrils.state.baseColor,
        flowColor: tendrils.state.flowColor,
        fadeColor: tendrils.state.fadeColor,
        spawn: resetSpawner.uniforms,
        opticalFlow: opticalFlowState,
        blend: blend.alphas,
        blur: blurState,
        // Just for calls
        // @todo Fix the animation lib properly, not just by convention
        calls: {}
    };

    const player = {
        // The main player, tied to the media time
        media: new Player(map(() => [], tracks, {}), tracks),

        // A miscellaneous player, time to app time
        app: new Player({ main: [] }, { main: tendrils.state })
    };

    // timer.media.end = player.media.end()+2000;
    // timer.media.loop = true;

    video.addEventListener('seeked',
        () => (appSettings.animate &&
            player.media.playFrom(video.currentTime*1000, 0)));


    // @todo Test sequence - move to own file?

    // The values to reset everything to on restart - commented-out ones are
    // omitted so global settings can be applied more easily.
    // Use this as a guide to see which track should change which values.
    const tracksStart = {
        tendrils: {
            // rootNum: 512,

            autoClearView: false,
            autoFade: true,

            // damping: 0.043,
            // speedLimit: 0.01,

            forceWeight: 0.017,
            varyForce: -0.25,

            flowWeight: 1,
            varyFlow: 0.3,

            flowDecay: 0.003,
            flowWidth: 5,

            speedAlpha: 0.005,
            colorMapAlpha: 0.1
        },
        tendrils2: {
            noiseWeight: 0.0003,
            varyNoise: 0.3,

            noiseScale: 1.5,
            varyNoiseScale: 1,

            noiseSpeed: 0.0006,
            varyNoiseSpeed: 0.05,
        },
        tendrils3: {
            target: 0.000005,
            varyTarget: 1,
            lineWidth: 1
        },
        baseColor: [1, 1, 1, 0.5],
        flowColor: [1, 1, 1, 0.05],
        fadeColor: [0, 0, 0, 0.05],
        spawn: {
            radius: 0.9,
            speed: 0.2
        },
        opticalFlow: {
            ...opticalFlowDefaults,
            speed: 0.001
        },
        blend: [1],
        blur: { ...blurState },
        calls: null
    };

    // Restart, clean slate

    const trackStartTime = 60;

    player.media.tracks.calls.to({
            call: [() => reset()],
            time: trackStartTime
        })
        .to({
            call: [
                () => {
                    restart();
                    toggleBase('dark');
                    spawnTargets.spawnImage = tendrils.targets;
                    spawnImage(tendrils.targets);
                }
            ],
            time: 200
        });

    // Array(10).fill(0).forEach((v, i) =>
    //     player.media.tracks.calls.to({
    //         call: [() => spawnImage(null)],
    //         time: 13900+(100*i)
    //     }));

    player.media.tracks.tendrils
        .over(4000, {
            to: {
                colorMapAlpha: 1
            },
            time: 6000,
            ease: [0, 0, 0, 1]
        });

    player.media.tracks.tendrils3
        .over(2000, {
            to: {
                target: 0.008,
                varyTarget: 3
            },
            time: 6000,
            ease: [0, 0, 0, 1]
        });

    player.media.tracks.baseColor
        .over(3000, {
            to: [1, 1, 1, 0],
            time: 6000,
            ease: [0, 0, 0, 1]
        });

    player.media.tracks.flowColor
        .over(3000, {
            to: [1, 1, 1, 0],
            time: 6000,
            ease: [0, 0, 0, 1]
        });

    player.media.tracks.opticalFlow
        .over(4000, {
            to: {
                speed: 0.12
            },
            time: 6000,
            ease: [0, 0, 1, 1]
        });

    player.media.apply((track, key) => {
        const apply = tracksStart[key];

        track.to({
            to: apply,
            time: trackStartTime
        });

        return { apply };
    });


    // Fullscreen

    // Needs to be called this way because calling the returned function directly is an
    // `Illegal Invocation`
    const requestFullscreen = prefixes('requestFullscreen', canvas);

    const fullscreen = (requestFullscreen && requestFullscreen.name && {
        request: () => canvas[requestFullscreen.name]()
    });


    // The main loop
    function render() {
        const dt = timer.app.tick().dt;

        player.app.play(timer.app.time);

        if(video.currentTime >= 0) {
            timer.media.tick(video.currentTime*1000);

            if(appSettings.animate) {
                player.media.play(timer.media.time);
            }
        }

        // Blend the color maps into tendrils one
        // @todo Only do this if necessary (skip if none or only one has alpha)
        blend.views[0] = opticalFlow.buffers[0];
        blend.draw(tendrils.colorMap);

        // The main event
        tendrils.step().draw();

        if(tendrils.buffers.length) {
            // Blur to the screen

            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            tendrils.drawFade();

            blurShader.bind();

            Object.assign(blurShader.uniforms, {
                    view: tendrils.buffers[0].color[0].bind(1),
                    resolution: tendrils.viewRes,
                    time: tendrils.timer.time
                },
                blurState);

            screen.render();

            tendrils.stepBuffers();
        }


        // Draw inputs to flow

        gl.viewport(0, 0, ...tendrils.flow.shape);

        tendrils.flow.bind();


        // Optical flow

        // @todo Replace the image color map with one of these textures updated each frame.
        // @todo Blur for optical flow? Maybe Sobel as well?
        // @see https://github.com/princemio/ofxMIOFlowGLSL/blob/master/src/ofxMioFlowGLSL.cpp

        if(video.readyState > 1 && !video.paused && Math.min(...rasterShape.video) > 0) {
            opticalFlow.resize(rasterShape.video);

            try {
                opticalFlow.setPixels(video);
            }
            catch(e) {
                console.warn(e);
            }

            if(opticalFlowState.speed) {
                opticalFlow.update({
                    speedLimit: state.speedLimit,
                    time: timer.app.time,
                    viewSize: tendrils.viewSize,
                    ...opticalFlowState
                });

                screen.render();
            }

            opticalFlow.step();
        }
    }


    function resize() {
        canvas.width = self.innerWidth;
        canvas.height = self.innerHeight;

        tendrils.resize();
    }

    // Go

    self.addEventListener('resize', throttle(resize, 200), false);

    resize();

    tendrils.setup();
    respawn();


    // Control panel

    const gui = {
        main: new dat.GUI({ autoPlace: false }),
        showing: (''+settings.edit !== 'false')
    };

    const containGUI = Object.assign(document.createElement('div'), {
            className: 'epok-edit-controls'
        });

    const preventKeyClash = (e) => e.stopPropagation();

    gui.main.domElement.addEventListener('keydown', preventKeyClash);
    gui.main.domElement.addEventListener('keyup', preventKeyClash);

    function updateGUI(node = gui.main) {
        if(node.__controllers) {
            node.__controllers.forEach((control) => control.updateDisplay());
        }

        for(let f in node.__folders) {
            updateGUI(node.__folders[f]);
        }
    }

    function toggleOpenGUI(open, node = gui.main, cascade = true) {
        ((open)? node.open() : node.close());

        if(cascade) {
            for(let f in node.__folders) {
                toggleOpenGUI(open, node.__folders[f]);
            }
        }
    }

    function toggleShowGUI(show = !gui.showing) {
        containGUI.classList[(show)? 'remove' : 'add']('epok-hide');
        gui.showing = show;
    }

    // Types of simple properties the GUI can handle with `.add`
    const simpleGUIRegEx = /^(object|array|undefined|null)$/gi;


    // Root level

    const rootControls = {};

    if(fullscreen) {
        rootControls.fullscreen = fullscreen.request;
    }


    // State, animation, import/export

    const keyframe = (to = { ...state }, call = null) =>
        // @todo Apply full state to each player track
        player.media.tracks.tendrils.smoothTo({
            to,
            call,
            time: timer.media.time,
            ease: [0, 0.95, 1]
        });

    const showExport = ((''+settings.prompt_show !== 'false')?
            (...rest) => self.prompt(...rest)
        :   (...rest) => console.log(...rest));

    Object.assign(rootControls, {
            showLink: () => showExport('Link:',
                location.href.replace((location.search || /$/gi),
                    '?'+querystring.encode({
                        ...settings,
                        video: encodeURIComponent(appSettings.videoURL),
                        animate: appSettings.animate
                    }))),
            showState: () => showExport(`Current state (@${timer.media.time}):`,
                toSource(player.media.tracks)),
            showSequence: () => showExport('Animation sequence:',
                toSource(player.media.frames({}))),

            keyframe
        });

    gui.main.add(appSettings, 'animate');

    gui.main.add(appSettings, 'videoURL').onFinishChange(() => video.src = mediaSrc());

    each((f, control) => gui.main.add(rootControls, control), rootControls);


    // Settings

    gui.settings = gui.main.addFolder('settings');

    for(let s in state) {
        if(!(typeof state[s]).match(simpleGUIRegEx)) {
            const control = gui.settings.add(state, s);

            // Some special cases

            if(s === 'rootNum') {
                control.onFinishChange((n) => {
                    tendrils.setup(n);
                    restart();
                });
            }
        }
    }


    // DAT.GUI's color controllers are a bit fucked.

    const colorDefaults = {
            baseColor: state.baseColor.slice(0, 3).map((c) => c*255),
            baseAlpha: state.baseColor[3],

            flowColor: state.flowColor.slice(0, 3).map((c) => c*255),
            flowAlpha: state.flowColor[3],

            fadeColor: state.fadeColor.slice(0, 3).map((c) => c*255),
            fadeAlpha: state.fadeColor[3]
        };

    const colorProxy = {...colorDefaults};

    const convertColors = () => {
        state.baseColor[3] = colorProxy.baseAlpha;
        Object.assign(state.baseColor,
                colorProxy.baseColor.map((c) => c/255));

        state.flowColor[3] = colorProxy.flowAlpha;
        Object.assign(state.flowColor,
            colorProxy.flowColor.map((c) => c/255));

        state.fadeColor[3] = colorProxy.fadeAlpha;
        Object.assign(state.fadeColor,
            colorProxy.fadeColor.map((c) => c/255));
    };

    gui.settings.addColor(colorProxy, 'flowColor').onChange(convertColors);
    gui.settings.add(colorProxy, 'flowAlpha').onChange(convertColors);

    gui.settings.addColor(colorProxy, 'baseColor').onChange(convertColors);
    gui.settings.add(colorProxy, 'baseAlpha').onChange(convertColors);

    gui.settings.addColor(colorProxy, 'fadeColor').onChange(convertColors);
    gui.settings.add(colorProxy, 'fadeAlpha').onChange(convertColors);

    convertColors();


    // Color map blend

    gui.blend = gui.main.addFolder('color blend');

    const blendKeys = ['video'];
    const blendProxy = reduce((proxy, k, i) => {
            proxy[k] = blend.alphas[i];

            return proxy;
        },
        blendKeys, {});

    const blendDefaults = { ...blendProxy };

    const convertBlend = () => reduce((alphas, v, k, proxy, i) => {
            alphas[i] = v;

            return alphas;
        },
        blendProxy, blend.alphas);

    for(let b = 0; b < blendKeys.length; ++b) {
        gui.blend.add(blendProxy, blendKeys[b]).onChange(convertBlend);
    }


    // Respawn

    gui.spawn = gui.main.addFolder('spawn');

    for(let s in resetSpawner.uniforms) {
        if(!(typeof resetSpawner.uniforms[s]).match(simpleGUIRegEx)) {
            gui.spawn.add(resetSpawner.uniforms, s);
        }
    }

    const resetSpawnerDefaults = {
        radius: 0.3,
        speed: 0.005
    };


    // Optical flow

    gui.opticalFlow = gui.main.addFolder('optical flow');

    for(let s in opticalFlowState) {
        if(!(typeof opticalFlowState[s]).match(simpleGUIRegEx)) {
            gui.opticalFlow.add(opticalFlowState, s);
        }
    }


    // Reflow

    gui.reflow = gui.main.addFolder('reflow');

    gui.reflow.add(flowPixelState, 'scale', Object.keys(flowPixelScales));


    // Time

    gui.time = gui.main.addFolder('time');

    const timeSettings = ['paused', 'step', 'rate', 'end', 'loop'];

    timeSettings.forEach((t) => gui.time.add(timer.app, t));


    // Blur

    gui.blur = gui.main.addFolder('blur');

    for(let s in blurDefaults) {
        if(!(typeof blurState[s]).match(simpleGUIRegEx)) {
            gui.blur.add(blurState, s);
        }
    }


    // Controls

    const controllers = {
        clear,
        clearView,
        clearFlow,
        respawn,
        spawnSamples,
        spawnImage,
        spawnFlow,
        spawnFastest,
        reset,
        restart,
        toggleBase,
        spawnImageTargets() {
            spawnTargets.spawnImage = tendrils.targets;
            spawnImage(tendrils.targets);
        }
    };


    gui.controls = gui.main.addFolder('controls');

    for(let c in controllers) {
        gui.controls.add(controllers, c);
    }


    // Presets

    gui.presets = gui.main.addFolder('presets');

    const presetters = {
        'Flow'() {
            Object.assign(state, {
                flowWidth: 5,
                colorMapAlpha: 0
            });

            Object.assign(resetSpawner.uniforms, {
                radius: 0.25,
                speed: 0.01
            });

            Object.assign(colorProxy, {
                baseAlpha: 0,
                baseColor: [0, 0, 0],
                flowAlpha: 1,
                flowColor: [255, 255, 255],
                fadeAlpha: Math.max(state.flowDecay, 0.05)
            });

            toggleBase('dark');
        },
        'Wings'() {
            Object.assign(state, {
                flowDecay: 0,
                colorMapAlpha: 0
            });

            Object.assign(resetSpawner.uniforms, {
                radius: 0.05,
                speed: 0.05
            });

            Object.assign(colorProxy, {
                flowAlpha: 0.01,
                baseAlpha: 0.8,
                fadeAlpha: 0
            });

            toggleBase('light');
            restart();
        },
        'Fluid'() {
            Object.assign(state, {
                autoClearView: true
            });

            Object.assign(colorProxy, {
                fadeAlpha: 0
            });

            toggleBase('light');
            clear();
        },
        'Flow only'() {
            Object.assign(state, {
                flowDecay: 0.001,
                forceWeight: 0.014,
                noiseWeight: 0,
                speedAlpha: 0
            });

            Object.assign(resetSpawner.uniforms, {
                radius: 0.4,
                speed: 0.15
            });

            Object.assign(colorProxy, {
                baseAlpha: 0.8,
                baseColor: [100, 200, 255],
                fadeAlpha: 0.1
            });

            toggleBase('dark');
        },
        'Noise only'() {
            Object.assign(state, {
                flowWeight: 0,
                noiseWeight: 0.003,
                noiseSpeed: 0.0005,
                noiseScale: 1.5,
                varyNoiseScale: 10,
                varyNoiseSpeed: 0.05,
                speedAlpha: 0,
                colorMapAlpha: 0.8
            });

            Object.assign(colorProxy, {
                baseAlpha: 0.4,
                baseColor: [255, 180, 50],
                fadeAlpha: 0.05,
                flowAlpha: 0
            });

            Object.assign(blendProxy, {
                video: 0
            });

            toggleBase('light');
        },
        'Sea'() {
            Object.assign(state, {
                flowWidth: 5,
                forceWeight: 0.013,
                noiseWeight: 0.002,
                flowDecay: 0.01,
                speedAlpha: 0,
                colorMapAlpha: 0.4
            });

            Object.assign(resetSpawner.uniforms, {
                radius: 1.5,
                speed: 0
            });

            Object.assign(colorProxy, {
                baseAlpha: 0.8,
                baseColor: [55, 155, 255],
                fadeAlpha: 0.3,
                fadeColor: [0, 58, 90]
            });

            toggleBase('dark');
        },
        'Ghostly'() {
            Object.assign(state, {
                flowDecay: 0,
                colorMapAlpha: 0.005
            });

            Object.assign(colorProxy, {
                baseAlpha: 0.25,
                baseColor: [255, 255, 255],
                flowAlpha: 0.03,
                fadeAlpha: 0.03,
                fadeColor: [0, 0, 0]
            });

            toggleBase('dark');
        },
        'Petri'() {
            Object.assign(state, {
                forceWeight: 0.015,
                noiseWeight: 0.001,
                flowDecay: 0.001,
                noiseScale: 200,
                noiseSpeed: 0.0001
            });

            Object.assign(colorProxy, {
                baseAlpha: 0.4,
                baseColor:[255, 203, 37],
                flowAlpha: 0.05,
                fadeAlpha: Math.max(state.flowDecay, 0.05)
            });

            Object.assign(resetSpawner.uniforms, {
                radius: 1/Math.max(...tendrils.viewSize),
                speed: 0
            });

            toggleBase('dark');
            clear();
        },
        'Turbulence'() {
            Object.assign(state, {
                noiseSpeed: 0.00005,
                noiseScale: 10,
                forceWeight: 0.014,
                noiseWeight: 0.003,
                speedAlpha: 0.000002,
                colorMapAlpha: 0.3
            });

            Object.assign(colorProxy, {
                baseAlpha: 0.3,
                baseColor: [100, 0, 0],
                flowAlpha: 0.5,
                flowColor: [255, 10, 10],
                fadeAlpha: 0.01,
                fadeColor: [0, 0, 0]
            });

            toggleBase('light');
        },
        'Rorschach'() {
            Object.assign(state, {
                noiseScale: 40,
                varyNoiseScale: 0.1,
                noiseSpeed: 0.00001,
                varyNoiseSpeed: 0.01,
                forceWeight: 0.014,
                noiseWeight: 0.0021,
                speedAlpha: 0.000002,
                colorMapAlpha: 0.2
            });

            Object.assign(flowPixelState, {
                scale: 'mirror xy'
            });

            Object.assign(colorProxy, {
                baseAlpha: 0.9,
                baseColor: [0, 0, 0],
                flowAlpha: 0.1,
                fadeAlpha: 0.05,
                fadeColor: [255, 255, 255]
            });

            toggleBase('dark');
        },
        'Roots'() {
            Object.assign(state, {
                flowDecay: 0,
                noiseSpeed: 0,
                noiseScale: 18,
                forceWeight: 0.015,
                noiseWeight: 0.0023,
                speedAlpha: 0.00005,
                lineWidth: 2,
                colorMapAlpha: 0.0001
            });

            Object.assign(colorProxy, {
                baseAlpha: 0.2,
                baseColor: [50, 255, 50],
                flowAlpha: 0.05,
                fadeAlpha: 0
            });

            toggleBase('dark');
            restart();
        },
        'Funhouse'() {
            Object.assign(state, {
                forceWeight: 0.0165,
                varyForce: 0.3,
                flowWeight: 0.5,
                varyFlow: 1,
                noiseWeight: 0.0015,
                varyNoise: 1,
                noiseScale: 40,
                varyNoiseScale: -4,
                noiseSpeed: 0.0001,
                varyNoiseSpeed: -3,
                flowDecay: 0.001,
                flowWidth: 8,
                speedAlpha: 0.00002,
                colorMapAlpha: 1
            });

            Object.assign(colorProxy, {
                baseAlpha: 0.2,
                baseColor: [0, 0, 0],
                flowAlpha: 0.05,
                fadeAlpha: 0.05,
                fadeColor: [0, 0, 0]
            });

            toggleBase('light');
            spawnImage(null);
        }
    };

    const wrapPresetter = (presetter) => {
        Object.assign(state, defaultState);
        Object.assign(resetSpawner.uniforms, resetSpawnerDefaults);
        Object.assign(flowPixelState, flowPixelDefaults);
        Object.assign(colorProxy, colorDefaults);
        Object.assign(blendProxy, blendDefaults);

        presetter();

        updateGUI();
        convertColors();
        convertBlend();
        // restart();
    };

    for(let p in presetters) {
        presetters[p] = wrapPresetter.bind(null, presetters[p]);
        gui.presets.add(presetters, p);
    }


    // Hide by default till the animation's over

    toggleOpenGUI(true);
    toggleOpenGUI(false, undefined, false);
    toggleShowGUI(gui.showing);

    // Add to the DOM

    containGUI.appendChild(gui.main.domElement);
    canvas.parentElement.appendChild(containGUI);


    // Keyboard mash!
    /**
     * Assign modifiers to keys:
     * - Hold down a letter key to select a setting:
     *     - Up/down key to raise/lower it a little.
     *     - Left/right key to raise/lower it a lot.
     *     - Backspace to reset it to its default.
     *     - Release it to record a frame.
     * - Spacebar for cam.
     * - Shift/ctrl/cmd for spawning.
     * - Numbers for presets.
     * - Symbols for smashing shapes/colours into the flow.
     *
     * Tween these with a default ease and duration (keyframe pair).
     * Edit the timeline for each setting, saving the settings on each
     * change into a keyframe (pair with default duration).
     *
     * @todo Playing with some functional stuff here, looks pretty mad.
     * @todo Smash in some shapes, flow inputs, colour inputs (discrete forms).
     * @todo Increment/decrement state values by various amounts.
     * @todo Use the above to play the visuals and set keyframes in real time?
     */
    function keyMash() {
        // Quick video control

        const togglePlay = (play = video.paused) =>
            ((play)? video.play() : video.pause());

        const scrub = (by) => {
            video.currentTime += by*0.001;
            togglePlay(true);
        };


        const keyframeCall = (...calls) => {
            keyframe(null, calls);
            each((call) => call(), calls);
        };

        const keyframeCaller = (...calls) => () => keyframeCall(...calls);


        // Invoke the functions for each setting being edited.
        const resetEach = (all) => {
                each((x) => (x.reset && x.reset()), all);
                updateGUI();
            };

        const adjustEach = curry((by, all) => {
                each((x) => (x.adjust && x.adjust(by)), all);
                updateGUI();
            });


        // Common case for editing a given setting.

        const copy = (into, source, key) => into[key] = source[key];
        const copier = curry(copy, copy.length+1);

        const adjust = (into, key, scale, by) => into[key] += scale*by;
        const adjuster = curry(adjust);

        const flip = (into, key) => into[key] = !into[key];
        const flipper = curry(flip, flip.length+1);


        // Shorthands

        const stateCopy = copier(state, defaultState);
        const stateEdit = adjuster(state);
        const stateFlip = flipper(state);

        const stateBool = (key) => ({
            reset: stateCopy(key),
            go: stateFlip(key)
        });

        const stateNum = (key, scale) => ({
            reset: stateCopy(key),
            adjust: stateEdit(key, scale)
        });


        const editing = {};

        /**
         * Anything that selects and may change a part of the state.
         * @todo Inputs for the other things in full state, controls, and
         *       presets.
         */
        const editMap = {

            '`': {
                reset: () => {
                    tendrils.setup(defaultState.rootNum);
                    restart();
                },
                adjust: (by) => {
                    tendrils.setup(state.rootNum*Math.pow(2, by));
                    restart();
                }
            },

            'P': stateBool('autoClearView'),

            'Q': stateNum('forceWeight', 0.01),
            'A': stateNum('flowWeight', 0.02),
            'W': stateNum('noiseWeight', 0.0002),

            'S': stateNum('flowDecay', 0.005),
            'D': stateNum('flowWidth', 1),

            'E': stateNum('noiseScale', 1),
            'R': stateNum('noiseSpeed', 0.002),

            'Z': stateNum('damping', 0.001),
            'X': stateNum('speedLimit', 0.0001),

            'N': stateNum('speedAlpha', 0.002),
            'M': stateNum('lineWidth', 0.1),

            // <control> is a special case for re-assigning keys, see below
            '<control>': (key, assign) => {
                delete editMap[key];
                delete callMap[key];

                callMap[key] = keyframeCaller(() =>
                        Object.assign(state, assign));
            }
        };

        const callMap = {
            'H': () => toggleShowGUI(),

            'O': keyframeCaller(() => tendrils.clear()),

            '0': keyframeCaller(presetters['Flow']),
            '1': keyframeCaller(presetters['Wings']),
            '2': keyframeCaller(presetters['Fluid']),
            // '3': keyframeCaller(presetters['Flow only']),
            '3': keyframeCaller(presetters['Ghostly']),
            '4': keyframeCaller(presetters['Noise only']),
            '5': keyframeCaller(presetters['Sea']),
            '6': keyframeCaller(presetters['Petri']),
            '7': keyframeCaller(presetters['Turbulence']),
            '8': keyframeCaller(presetters['Rorschach']),
            '9': keyframeCaller(presetters['Funhouse']),

            '-': adjustEach(-0.1),
            '=': adjustEach(0.1),
            '<down>': adjustEach(-1),
            '<up>': adjustEach(1),
            '<left>': adjustEach(-5),
            '<right>': adjustEach(5),

            '<escape>': (...rest) => {
                resetEach(editMap);
                keyframe(...rest);
            },
            '<caps-lock>': resetEach,

            '<space>': () => togglePlay(),

            '[': () => scrub(-2000),
            ']': () => scrub(2000),
            '<enter>': keyframe,
            // @todo Update this to match the new Player API
            '<backspace>': () =>
                player.media.trackAt(timer.media.time)
                    .spliceAt(timer.media.time),

            '\\': keyframeCaller(() => reset()),
            "'": keyframeCaller(() => spawnFlow()),
            ';': keyframeCaller(() => spawnFastest()),

            '<shift>': keyframeCaller(() => restart()),
            '/': keyframeCaller(() => spawnSamples()),
            '.': keyframeCaller(() => spawnImage(null))
        };

        if(fullscreen) {
            callMap['F'] = fullscreen.request;
        }

        // @todo Throttle so multiple states can go into one keyframe.
        // @todo Toggle this on or off any time - from GUI flag etc.
        document.body.addEventListener('keydown', (e) => {
                // Control is a special case to assign the current state to
                // a key.
                const remap = editing['<control>'];
                const key = vkey[e.keyCode];
                const mapped = editMap[key];
                const call = callMap[key];

                if(remap) {
                    remap(key, { ...state });
                }
                else if(mapped && !editing[key]) {
                    editing[key] = mapped;

                    if(mapped.go) {
                        mapped.go(editing, state);
                    }
                }
                else if(call) {
                    call(editing, state);
                }

                updateGUI();

                if(mapped || call) {
                    e.preventDefault();
                    e.stopPropagation();
                }
            },
            false);

        document.body.addEventListener('keyup',
            (e) => {
                const key = vkey[e.keyCode];
                const mapped = editMap[key];
                const call = callMap[key];

                if(mapped && editing[key]) {
                    if(key !== '<control>' && !editing['<control>']) {
                        keyframe({ ...state });
                    }

                    // @todo Needed?
                    editing[key] = null;
                    delete editing[key];
                }

                if(mapped || call) {
                    e.preventDefault();
                    e.stopPropagation();
                }
            },
            false);
    }

    if(''+settings.keyboard !== 'false') {
        keyMash();
    }

    // Need some stuff exposed.
    // @todo Come up with a better interface than this.
    const out = {
        ...controllers,
        tendrils,
        tracks,
        defaultState,
        timer
    };

    // Debug
    window.tendrils = out;

    return out;
};
