/*global define*/
define(function() {
    "use strict";

    var canvas;

    /**
     * Extract a pixel array from a loaded image.  Draws the image
     * into a canvas so it can read the pixels back.
     *
     * @param {Image} image The image to extract pixels from.
     *
     * @returns {CanvasPixelArray} The pixels of the image.
     */
    var imageToPixels = function(image) {
        if (typeof canvas === 'undefined') {
            canvas = document.createElement('canvas');
        }

        var width = image.width;
        var height = image.height;

        canvas.width = width;
        canvas.height = height;

        var context2d = canvas.getContext('2d');
        context2d.globalCompositeOperation = 'copy';
        context2d.drawImage(image, 0, 0);

        return context2d.getImageData(0, 0, width, height).data;
    };

    return imageToPixels;
});