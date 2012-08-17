/*global define*/
define([
        '../Core/combine',
        '../Core/defaultValue',
        '../Core/destroyObject',
        '../Core/DeveloperError',
        '../Core/Math',
        '../Core/Cartesian2',
        '../Core/Extent',
        '../Core/PlaneTessellator',
        './ImageryCache',
        './Tile',
        './TileImagery',
        './TileState',
        './TexturePool',
        './Projections',
        '../ThirdParty/when'
    ], function(
        combine,
        defaultValue,
        destroyObject,
        DeveloperError,
        CesiumMath,
        Cartesian2,
        Extent,
        PlaneTessellator,
        ImageryCache,
        Tile,
        TileImagery,
        TileState,
        TexturePool,
        Projections,
        when) {
    "use strict";

    /**
     * An imagery layer that display tiled image data from a single imagery provider
     * on a central body.
     *
     * @name ImageryLayer
     *
     * @param {ImageryProvider} imageryProvider the imagery provider to use.
     * @param {Extent} [description.extent=imageryProvider.extent] The extent of the layer.
     * @param {Number} [description.maxScreenSpaceError=1.0] DOC_TBA
     * @param {Number} [description.alpha=1.0] The alpha blending value of this layer, from 0.0 to 1.0.
     */
    function ImageryLayer(imageryProvider, description) {
        this.imageryProvider = imageryProvider;

        description = defaultValue(description, {});

        this.extent = defaultValue(description.extent, imageryProvider.extent);
        this.extent = defaultValue(this.extent, Extent.MAX_VALUE);

        /**
         * DOC_TBA
         *
         * @type {Number}
         */
        this.maxScreenSpaceError = defaultValue(description.maxScreenSpaceError, 1.0);

        this._imageryCache = new ImageryCache();
        this._texturePool = new TexturePool();

        /**
         * The alpha blending value of this layer, from 0.0 to 1.0.
         *
         * @type {Number}
         */
        this.alpha = defaultValue(description.alpha, 1.0);

        this._tileFailCount = 0;

        /**
         * The maximum number of tiles that can fail consecutively before the
         * layer will stop loading tiles.
         *
         * @type {Number}
         */
        this.maxTileFailCount = 10;

        /**
         * The maximum number of failures allowed for each tile before the
         * layer will stop loading a failing tile.
         *
         * @type {Number}
         */
        this.perTileMaxFailCount = 3;

        /**
         * The number of seconds between attempts to retry a failing tile.
         *
         * @type {Number}
         */
        this.failedTileRetryTime = 5.0;

        this._levelZeroMaximumTexelSpacing = undefined;
    }

    /**
     * Gets the level with the specified world coordinate spacing between texels, or less.
     *
     * @param {Number} texelSpacing The texel spacing for which to find a corresponding level.
     * @param {Number} latitudeClosestToEquator The latitude closest to the equator that we're concerned with.
     * @returns {Number} The level with the specified texel spacing or less.
     */
    ImageryLayer.prototype._getLevelWithMaximumTexelSpacing = function(texelSpacing, latitudeClosestToEquator) {
        var levelZeroMaximumTexelSpacing = this._levelZeroMaximumTexelSpacing;
        //if (typeof levelZeroMaximumTexelSpacing === 'undefined') {
            var imageryProvider = this.imageryProvider;
            var tilingScheme = imageryProvider.tilingScheme;
            var ellipsoid = tilingScheme.ellipsoid;
            var latitudeFactor = Math.cos(latitudeClosestToEquator);
            //var latitudeFactor = 1.0;
            levelZeroMaximumTexelSpacing = ellipsoid.getMaximumRadius() * 2 * Math.PI * latitudeFactor / (imageryProvider.tileWidth * tilingScheme.numberOfLevelZeroTilesX);
            this._levelZeroMaximumTexelSpacing = levelZeroMaximumTexelSpacing;
        //}

        var twoToTheLevelPower = this._levelZeroMaximumTexelSpacing / texelSpacing;
        var level = Math.log(twoToTheLevelPower) / Math.log(2);

        // Round the level up, unless it's really close to the lower integer.
//        var ceiling = Math.ceil(level);
//        if (ceiling - level > 0.99) {
//            ceiling -= 1;
//        }
//        return ceiling | 0;
        var rounded = Math.round(level);
        return rounded | 0;
    };

    ImageryLayer.prototype.createTileImagerySkeletons = function(tile, terrainProvider) {
        var imageryProvider = this.imageryProvider;
        var imageryTilingScheme = imageryProvider.tilingScheme;

        // Compute the extent of the imagery from this imageryProvider that overlaps
        // the geometry tile.  The ImageryProvider and ImageryLayer both have the
        // opportunity to constrain the extent.  The imagery TilingScheme's extent
        // always fully contains the ImageryProvider's extent.
        var extent = tile.extent.intersectWith(imageryProvider.extent);
        extent = extent.intersectWith(this.extent);

        if (extent.east <= extent.west ||
            extent.north <= extent.south) {
            // There is no overlap between this terrain tile and this imagery
            // provider, so no skeletons need to be created.
            return false;
        }

        var latitudeClosestToEquator = 0.0;
        if (extent.south > 0.0) {
            latitudeClosestToEquator = extent.south;
        } else if (extent.north < 0.0) {
            latitudeClosestToEquator = extent.north;
        }

        // Compute the required level in the imagery tiling scheme.
        // TODO: this should be imagerySSE / terrainSSE.
        var errorRatio = 1.0;
        var targetGeometricError = errorRatio * terrainProvider.getLevelMaximumGeometricError(tile.level);
        var imageryLevel = this._getLevelWithMaximumTexelSpacing(targetGeometricError, latitudeClosestToEquator);
        imageryLevel = Math.max(0, Math.min(imageryProvider.maxLevel, imageryLevel));

        var northwestTileCoordinates = imageryTilingScheme.positionToTileXY(extent.getNorthwest(), imageryLevel);
        var southeastTileCoordinates = imageryTilingScheme.positionToTileXY(extent.getSoutheast(), imageryLevel);

        // If the southeast corner of the extent lies very close to the north or west side
        // of the southeast tile, we don't actually need the southernmost or easternmost
        // tiles.
        // Similarly, if the northwest corner of the extent list very close to the south or east side
        // of the northwest tile, we don't actually need the northernmost or westernmost tiles.
        // TODO: The northwest corner is especially sketchy...  Should we be doing something
        // elsewhere to ensure better alignment?
        // TODO: Is CesiumMath.EPSILON10 the right epsilon to use?
        var northwestTileExtent = imageryTilingScheme.tileXYToExtent(northwestTileCoordinates.x, northwestTileCoordinates.y, imageryLevel);
        if (Math.abs(northwestTileExtent.south - extent.north) < CesiumMath.EPSILON10) {
            ++northwestTileCoordinates.y;
        }
        if (Math.abs(northwestTileExtent.east - extent.west) < CesiumMath.EPSILON10) {
            ++northwestTileCoordinates.x;
        }

        var southeastTileExtent = imageryTilingScheme.tileXYToExtent(southeastTileCoordinates.x, southeastTileCoordinates.y, imageryLevel);
        if (Math.abs(southeastTileExtent.north - extent.south) < CesiumMath.EPSILON10) {
            --southeastTileCoordinates.y;
        }
        if (Math.abs(southeastTileExtent.west - extent.east) < CesiumMath.EPSILON10) {
            --southeastTileCoordinates.x;
        }

        // Create TileImagery instances for each imagery tile overlapping this terrain tile.
        // We need to do all texture coordinate computations in the imagery tile's tiling scheme.
        var terrainExtent = imageryTilingScheme.extentToNativeExtent(tile.extent);
        var terrainWidth = terrainExtent.east - terrainExtent.west;
        var terrainHeight = terrainExtent.north - terrainExtent.south;

        for ( var i = northwestTileCoordinates.x; i <= southeastTileCoordinates.x; i++) {
            for ( var j = northwestTileCoordinates.y; j <= southeastTileCoordinates.y; j++) {
                var imageryExtent = imageryTilingScheme.tileXYToNativeExtent(i, j, imageryLevel);
                var textureTranslation = new Cartesian2(
                        (imageryExtent.west - terrainExtent.west) / terrainWidth,
                        (imageryExtent.south - terrainExtent.south) / terrainHeight);
                var textureScale = new Cartesian2(
                        (imageryExtent.east - imageryExtent.west) / terrainWidth,
                        (imageryExtent.north - imageryExtent.south) / terrainHeight);
                tile.imagery.push(new TileImagery(this, i, j, imageryLevel, textureTranslation, textureScale));
            }
        }

        return true;
    };

    var activeTileImageRequests = {};

    ImageryLayer.prototype.requestImagery = function(tileImagery) {
        var imageryProvider = this.imageryProvider;
        var imageryCache = this._imageryCache;
        var hostname;

        when(imageryProvider.buildImageUrl(tileImagery.x, tileImagery.y, tileImagery.level), function(imageUrl) {
            var cacheItem = imageryCache.get(imageUrl);
            if (typeof cacheItem !== 'undefined') {
                if (typeof cacheItem.texture === 'undefined') {
                    tileImagery.state = TileState.UNLOADED;
                } else {
                    tileImagery.texture = cacheItem.texture;
                    tileImagery.state = TileState.READY;
                }
                return false;
            }

            hostname = getHostname(imageUrl);
            if (hostname !== '') {
                var activeRequestsForHostname = defaultValue(activeTileImageRequests[hostname], 0);

                //cap image requests per hostname, because the browser itself is capped,
                //and we have no way to cancel an image load once it starts, but we need
                //to be able to reorder pending image requests
                if (activeRequestsForHostname > 6) {
                    // postpone loading tile
                    tileImagery.state = TileState.UNLOADED;
                    return false;
                }

                activeTileImageRequests[hostname] = activeRequestsForHostname + 1;
            }

            imageryCache.beginAdd(imageUrl);

            tileImagery.imageUrl = imageUrl;
            return imageryProvider.requestImage(imageUrl);
        }).then(function(image) {
            if (typeof image === 'boolean') {
                return;
            }

            activeTileImageRequests[hostname]--;

            tileImagery.image = image;

            if (typeof image === 'undefined') {
                tileImagery.state = TileState.INVALID;
                imageryCache.abortAdd(tileImagery.imageUrl);
                return;
            }

            tileImagery.state = TileState.RECEIVED;
        }, function(e) {
            /*global console*/
            console.error('failed to load imagery: ' + e);
            tileImagery.state = TileState.FAILED;
            imageryCache.abortAdd(tileImagery.imageUrl);
        });
    };

    ImageryLayer.prototype.transformImagery = function(context, tileImagery) {
        this.imageryProvider.transformImagery(context, tileImagery);
    };

    ImageryLayer.prototype.createResources = function(context, tileImagery) {
        this.imageryProvider.createResources(context, tileImagery, this._texturePool);

        if (tileImagery.state === TileState.READY) {
            tileImagery.texture = this._imageryCache.finishAdd(tileImagery.imageUrl, tileImagery.texture);
            tileImagery.imageUrl = undefined;
        }
    };

    var anchor;
    function getHostname(url) {
        if (typeof anchor === 'undefined') {
            anchor = document.createElement('a');
        }
        anchor.href = url;
        return anchor.hostname;
    }

    /**
     * Returns true if this object was destroyed; otherwise, false.
     * <br /><br />
     * If this object was destroyed, it should not be used; calling any function other than
     * <code>isDestroyed</code> will result in a {@link DeveloperError} exception.
     *
     * @memberof ImageryLayer
     *
     * @return {Boolean} True if this object was destroyed; otherwise, false.
     *
     * @see ImageryLayer#destroy
     */
    ImageryLayer.prototype.isDestroyed = function() {
        return false;
    };

    /**
     * Destroys the WebGL resources held by this object.  Destroying an object allows for deterministic
     * release of WebGL resources, instead of relying on the garbage collector to destroy this object.
     * <br /><br />
     * Once an object is destroyed, it should not be used; calling any function other than
     * <code>isDestroyed</code> will result in a {@link DeveloperError} exception.  Therefore,
     * assign the return value (<code>undefined</code>) to the object as done in the example.
     *
     * @memberof ImageryLayer
     *
     * @return {undefined}
     *
     * @exception {DeveloperError} This object was destroyed, i.e., destroy() was called.
     *
     * @see ImageryLayer#isDestroyed
     *
     * @example
     * imageryLayer = imageryLayer && imageryLayer.destroy();
     */
    ImageryLayer.prototype.destroy = function() {
        this._texturePool = this._texturePool && this._texturePool.destroy();

        return destroyObject(this);
    };

    return ImageryLayer;
});