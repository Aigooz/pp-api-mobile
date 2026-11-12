/* Liquid glass for the navigation surface.
   Chromium gets real edge refraction through an SVG displacement filter.
   WebKit gets a fitted clear-glass material because SVG filters inside
   backdrop-filter are not supported there. */
(function (global) {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var P = {
    width: 64
  };

  function supportsRefraction() {
    if (!global.CSS || !CSS.supports) return false;
    var brands = global.navigator && global.navigator.userAgentData && global.navigator.userAgentData.brands;
    if (brands && brands.some(function (item) {
      return /Chromium|Google Chrome|Microsoft Edge/.test(item.brand || '');
    })) return true;
    return /\bChrome\/\d+/.test(global.navigator ? global.navigator.userAgent : '');
  }

  function svgNode(tag, attrs) {
    var node = document.createElementNS(SVG_NS, tag);
    Object.keys(attrs || {}).forEach(function (key) { node.setAttribute(key, String(attrs[key])); });
    return node;
  }

  function roundedRectDistance(px, py, halfW, halfH, radius) {
    var ax = Math.abs(px);
    var ay = Math.abs(py);
    var qx = ax - (halfW - radius);
    var qy = ay - (halfH - radius);
    var d;
    var nx;
    var ny;
    if (qx > 0 && qy > 0) {
      var len = Math.sqrt(qx * qx + qy * qy) || 1;
      d = len - radius;
      nx = qx / len;
      ny = qy / len;
    } else if (qx > qy) {
      d = qx - radius;
      nx = 1;
      ny = 0;
    } else {
      d = qy - radius;
      nx = 0;
      ny = 1;
    }
    return { d: d, nx: nx * (px < 0 ? -1 : 1), ny: ny * (py < 0 ? -1 : 1) };
  }

  function makeDisplacementMap(width, height, radius, bezel) {
    var size = P.width;
    var canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    var ctx = canvas.getContext('2d');
    var image = ctx.createImageData(size, size);
    var data = image.data;
    var halfW = width / 2;
    var halfH = height / 2;
    var innerW = Math.max(1, halfW - bezel);
    var innerH = Math.max(1, halfH - bezel);
    var innerRadius = Math.max(0, Math.min(radius, Math.min(innerW, innerH)));
    var falloff = 1 / Math.max(1, bezel * 1.2);
    var stepX = width / size;
    var stepY = height / size;

    for (var y = 0; y < size; y++) {
      var py = (y + .5) * stepY - halfH;
      for (var x = 0; x < size; x++) {
        var px = (x + .5) * stepX - halfW;
        var sample = roundedRectDistance(px, py, halfW, halfH, radius);
        var index = (y * size + x) * 4;
        if (sample.d >= 0) {
          data[index] = 128;
          data[index + 1] = 128;
          data[index + 2] = 128;
          data[index + 3] = 0;
          continue;
        }

        var edge = Math.max(0, 1 + sample.d * falloff);
        edge = edge * edge * (3 - 2 * edge);
        var distanceX = Math.max(0, Math.abs(px) - innerW + innerRadius);
        var distanceY = Math.max(0, Math.abs(py) - innerH + innerRadius);
        var innerDistance = Math.sqrt(distanceX * distanceX + distanceY * distanceY) - innerRadius;
        var flat = Math.max(0, Math.min(1, .5 - innerDistance * falloff));
        var bend = edge * (.28 + flat * .72);
        var nx = sample.nx * bend;
        var ny = sample.ny * bend;
        var highlight = Math.max(0, 1 - Math.max(0, sample.d + bezel * .56) / Math.max(1, bezel * .56));
        highlight = Math.pow(highlight, 1.8);

        data[index] = Math.round((.5 + nx * .34) * 255);
        data[index + 1] = Math.round((.5 + ny * .34) * 255);
        data[index + 2] = Math.round(128 + highlight * 110);
        data[index + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
    return canvas.toDataURL();
  }

  function createFilter(id, map, scale, width, height) {
    var filter = svgNode('filter', {
      id: id,
      filterUnits: 'objectBoundingBox',
      primitiveUnits: 'userSpaceOnUse',
      'color-interpolation-filters': 'sRGB',
      x: '-8%', y: '-16%', width: '116%', height: '132%'
    });
    filter.appendChild(svgNode('feImage', {
      href: map,
      preserveAspectRatio: 'none',
      x: '0', y: '0', width: width, height: height,
      result: 'glassMap'
    }));
    filter.appendChild(svgNode('feGaussianBlur', {
      in: 'SourceGraphic',
      stdDeviation: 18,
      result: 'frost'
    }));
    filter.appendChild(svgNode('feDisplacementMap', {
      in: 'frost',
      in2: 'glassMap',
      scale: scale,
      xChannelSelector: 'R',
      yChannelSelector: 'G',
      result: 'refracted'
    }));
    filter.appendChild(svgNode('feComposite', {
      in: 'refracted', in2: 'glassMap', operator: 'in', result: 'shaped'
    }));
    filter.appendChild(svgNode('feColorMatrix', {
      in: 'shaped',
      type: 'saturate',
      values: 1.28,
      result: 'tinted'
    }));
    var defs = svgNode('defs', {});
    defs.appendChild(filter);
    return { defs: defs, filter: filter };
  }

  function LiquidGlass(element) {
    this.element = element;
    this.layer = document.createElement('span');
    this.layer.className = 'tabbar-glass';
    this.layer.setAttribute('aria-hidden', 'true');
    element.insertBefore(this.layer, element.firstChild);
    this.supported = supportsRefraction();
    this.id = 'pp-glass-' + Math.random().toString(36).slice(2);
    this.frame = 0;
    this.width = 0;
    this.height = 0;
    this.radius = 0;
    this.render = this.render.bind(this);
    if (this.supported) {
      this.holder = document.createElement('div');
      this.holder.setAttribute('aria-hidden', 'true');
      this.holder.style.cssText = 'position:fixed;width:0;height:0;overflow:hidden;pointer-events:none';
      document.body.appendChild(this.holder);
    }
    this.schedule();
  }

  LiquidGlass.prototype.schedule = function () {
    var self = this;
    if (this.frame || !global.requestAnimationFrame) return;
    this.frame = global.requestAnimationFrame(function () {
      self.frame = 0;
      self.render();
    });
  };

  LiquidGlass.prototype.render = function () {
    var rect = this.element.getBoundingClientRect();
    var width = Math.round(rect.width);
    var height = Math.round(rect.height);
    if (!width || !height) return;
    var radius = Math.min(height / 2, parseFloat(getComputedStyle(this.element).borderTopLeftRadius) || height / 2);
    if (!this.supported) {
      this.element.classList.add('glass-fallback');
      return;
    }
    if (width === this.width && height === this.height && radius === this.radius) return;
    this.width = width;
    this.height = height;
    this.radius = radius;
    this.holder.replaceChildren();
    var bezel = Math.max(4, Math.min(28, height * .42));
    var map = makeDisplacementMap(width, height, radius, bezel);
    var result = createFilter(this.id, map, Math.max(2, height * .055), width, height);
    this.holder.appendChild(result.defs);
    this.layer.style.backdropFilter = 'url(#' + this.id + ')';
    this.layer.style.webkitBackdropFilter = 'url(#' + this.id + ')';
    this.element.classList.add('glass-refract');
  };

  LiquidGlass.prototype.destroy = function () {
    if (this.frame) global.cancelAnimationFrame(this.frame);
    if (this.holder) this.holder.remove();
    this.layer.remove();
    this.element.classList.remove('glass-refract', 'glass-fallback');
  };

  global.PpGlass = {
    create: function (element) { return new LiquidGlass(element); },
    supported: supportsRefraction
  };
})(window);
