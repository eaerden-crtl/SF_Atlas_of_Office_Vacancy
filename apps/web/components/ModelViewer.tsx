'use client';

import { useEffect, useRef } from 'react';
import {
  AmbientLight,
  Box3,
  Color,
  DirectionalLight,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader';

interface ModelViewerProps {
  src: string;
  className?: string;
}

const BACKGROUND_COLOR = '#f1f5f9';

export default function ModelViewer({ src, className }: ModelViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const renderer = new WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.setClearColor(new Color(BACKGROUND_COLOR), 1);
    container.appendChild(renderer.domElement);

    const scene = new Scene();
    const camera = new PerspectiveCamera(45, 1, 0.1, 1000);
    camera.position.set(4, 4, 4);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;

    scene.add(new AmbientLight(0xffffff, 0.8));
    const keyLight = new DirectionalLight(0xffffff, 0.8);
    keyLight.position.set(6, 8, 6);
    scene.add(keyLight);

    let frameId = 0;
    const animate = () => {
      controls.update();
      renderer.render(scene, camera);
      frameId = window.requestAnimationFrame(animate);
    };

    const resize = () => {
      const { width, height } = container.getBoundingClientRect();
      const safeWidth = Math.max(1, width);
      const safeHeight = Math.max(1, height);
      renderer.setSize(safeWidth, safeHeight);
      camera.aspect = safeWidth / safeHeight;
      camera.updateProjectionMatrix();
    };

    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);

    const loader = new GLTFLoader();
    loader.load(
      src,
      (gltf) => {
        scene.add(gltf.scene);
        const bounds = new Box3().setFromObject(gltf.scene);
        const size = new Vector3();
        bounds.getSize(size);
        const center = new Vector3();
        bounds.getCenter(center);

        gltf.scene.position.sub(center);
        const maxDim = Math.max(size.x, size.y, size.z);
        const distance = maxDim * 1.8 || 6;
        camera.position.set(distance, distance, distance);
        camera.lookAt(0, 0, 0);
        controls.target.set(0, 0, 0);
      },
      undefined,
      () => {
        // Leave the viewer blank if loading fails.
      }
    );

    animate();

    return () => {
      window.cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      controls.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode) {
        renderer.domElement.parentNode.removeChild(renderer.domElement);
      }
    };
  }, [src]);

  return <div className={className} ref={containerRef} />;
}
