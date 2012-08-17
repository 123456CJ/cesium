/*global define*/
define([
        '../Core/defaultValue',
        '../Core/destroyObject',
        '../Core/DeveloperError',
        '../Core/Math',
        '../Core/Cartesian2',
        '../Core/Ellipsoid',
        '../Core/Extent',
        './TileState'
    ], function(
        defaultValue,
        destroyObject,
        DeveloperError,
        CesiumMath,
        Cartesian2,
        Ellipsoid,
        Extent,
        TileState) {
    "use strict";

    /**
     * A node in the quadtree representing the surface of a {@link CentralBody}.
     * A tile holds the surface geometry for its horizontal extent and zero or
     * more imagery textures overlaid on the geometry.
     *
     * @alias Tile
     * @constructor
     *
     * @param {TilingScheme} description.tilingScheme The tiling scheme of which the new tile is a part, such as a
     *                                                {@link WebMercatorTilingScheme} or a {@link GeographicTilingScheme}.
     * @param {Number} description.x The tile x coordinate.
     * @param {Number} description.y The tile y coordinate.
     * @param {Number} description.level The tile level-of-detail.
     * @param {Tile} description.parent The parent of this tile in a tile tree system.
     *
     * @exception {DeveloperError} Either description.extent or both description.x and description.y is required.
     * @exception {DeveloperError} description.level is required.
     */
    var Tile = function(description) {
        if (typeof description === 'undefined') {
            throw new DeveloperError('description is required.');
        }

        if (typeof description.x === 'undefined' || typeof description.y === 'undefined') {
            if (typeof description.extent === 'undefined') {
                throw new DeveloperError('Either description.extent is required or description.x and description.y are required.');
            }
        } else if (description.x < 0 || description.y < 0) {
            throw new DeveloperError('description.x and description.y must be greater than or equal to zero.');
        }

        if (typeof description.level === 'undefined' || description.zoom < 0) {
            throw new DeveloperError('description.level is required and must be greater than or equal to zero.');
        }

        if (typeof description.tilingScheme === 'undefined') {
            throw new DeveloperError('description.tilingScheme is required.');
        }

        /**
         * The tiling scheme used to tile the surface.
         *
         * @type TilingScheme
         */
        this.tilingScheme = description.tilingScheme;

        /**
         * The x coordinate.
         *
         * @type Number
         */
        this.x = description.x;

        /**
         * The y coordinate.
         *
         * @type Number
         */
        this.y = description.y;

        /**
         * The level-of-detail, where zero is the coarsest, least-detailed.
         *
         * @type Number
         */
        this.level = description.level;

        /**
         * The parent of this tile in a tile tree system.
         *
         * @type Tile
         */
        this.parent = description.parent;

        /**
         * The children of this tile in a tile tree system.
         *
         * @type Array
         */
        this.children = undefined;

        /**
         * The cartographic extent of the tile, with north, south, east and
         * west properties in radians.
         *
         * @type Extent
         */
        this.extent = this.tilingScheme.tileXYToExtent(this.x, this.y, this.level);

        /**
         * The {@link VertexArray} defining the geometry of this tile.
         *
         * @type VertexArray
         */
        this.vertexArray = undefined;

        var tilingScheme = description.tilingScheme;
        if (typeof description.extent !== 'undefined') {
            var coords = tilingScheme.extentToTileXY(description.extent, this.level);
            this.x = coords.x;
            this.y = coords.y;

            this.extent = description.extent;
        } else {
            this.x = description.x;
            this.y = description.y;

            this.extent = tilingScheme.tileXYToExtent(this.x, this.y, this.level);
        }

        this.center = undefined;
        this._boundingSphere3D = undefined;
        this._occludeePoint = undefined;

        this._projection = undefined;
        this._boundingSphere2D = undefined;
        this._boundingRectangle = undefined;

        this._previous = undefined;
        this._next = undefined;

        // TODO: get rid of _imagery.
        this._imagery = {};
        this.imagery = [];

        this.state = TileState.UNLOADED;
        this.geometry = undefined;
        this.transformedGeometry = undefined;
    };

    /**
     * Returns an array of tiles that would be at the next level of the tile tree.
     *
     * @memberof Tile
     *
     * @return {Array} The list of child tiles.
     */
    Tile.prototype.getChildren = function() {
        if (typeof this.children === 'undefined') {
            var tilingScheme = this.tilingScheme;
            var level = this.level + 1;
            var x = this.x * 2;
            var y = this.y * 2;
            this.children = [new Tile({
                tilingScheme : tilingScheme,
                x : x,
                y : y,
                level : level,
                parent : this
            }), new Tile({
                tilingScheme : tilingScheme,
                x : x + 1,
                y : y,
                level : level,
                parent : this
            }), new Tile({
                tilingScheme : tilingScheme,
                x : x,
                y : y + 1,
                level : level,
                parent : this
            }), new Tile({
                tilingScheme : tilingScheme,
                x : x + 1,
                y : y + 1,
                level : level,
                parent : this
            })];
        }

        return this.children;
    };

    Tile.prototype.computeMorphBounds = function(morphTime, projection) {
        return Extent.computeMorphBoundingSphere(this.extent, this.tilingScheme.ellipsoid, morphTime, projection);
    };

    /**
     * The bounding sphere for the geometry.
     *
     * @memberof Tile
     *
     * @return {BoundingSphere} The bounding sphere.
     */
    Tile.prototype.get3DBoundingSphere = function() {
        if (typeof this._boundingSphere3D === 'undefined') {
            this._boundingSphere3D = Extent.compute3DBoundingSphere(this.extent, this.tilingScheme.ellipsoid);
        }

        return this._boundingSphere3D;
    };

    /**
     * Computes a point that when visible means the geometry for this tile is visible.
     *
     * @memberof Tile
     *
     * @return {Cartesian3} The occludee point or undefined.
     */
    Tile.prototype.getOccludeePoint = function() {
        if (typeof this._occludeePoint === 'undefined') {
            this._occludeePoint = Extent.computeOccludeePoint(this.extent, this.tilingScheme.ellipsoid);
        }

        return this._occludeePoint.valid ? this._occludeePoint.occludeePoint : undefined;
    };

    function compute2DBounds(tile, projection) {
        if (typeof projection === 'undefined' || tile._projection === projection) {
            return;
        }

        var extent = tile.extent;
        tile._boundingRectangle = Extent.computeBoundingRectangle(extent, projection);
        tile._boundingSphere2D = Extent.compute2DBoundingSphere(extent, projection);
        tile._projection = projection;
    }

    /**
     * The bounding sphere for the geometry when the extent is projected onto a surface that is displayed in 3D.
     *
     * @memberof Tile
     *
     * @return {BoundingSphere} The bounding sphere.
     */
    Tile.prototype.get2DBoundingSphere = function(projection) {
        compute2DBounds(this, projection);

        return this._boundingSphere2D;
    };

    /**
     * The bounding rectangle for when the tile is projected onto a surface that is displayed in 2D.
     *
     * @memberof Tile
     *
     * @return {Rectangle} The bounding rectangle.
     */
    Tile.prototype.get2DBoundingRectangle = function(projection) {
        compute2DBounds(this, projection);

        return this._boundingRectangle;
    };

    /**
     * Returns true if this object was destroyed; otherwise, false.
     * <br /><br />
     * If this object was destroyed, it should not be used; calling any function other than
     * <code>isDestroyed</code> will result in a {@link DeveloperError} exception.
     *
     * @memberof Tile
     *
     * @return {Boolean} True if this object was destroyed; otherwise, false.
     *
     * @see Tile#destroy
     */
    Tile.prototype.isDestroyed = function() {
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
     * @memberof Tile
     *
     * @return {undefined}
     *
     * @exception {DeveloperError} This object was destroyed, i.e., destroy() was called.
     *
     * @see Tile#isDestroyed
     *
     * @example
     * tile = tile && tile.destroy();
     */
    Tile.prototype.destroy = function() {
        this.vertexArray = this.vertexArray && this.vertexArray.destroy();
        var imagery = this._imagery;
        Object.keys(imagery).forEach(function(key) {
            var tileImagery = imagery[key];
            tileImagery._texture = tileImagery._texture && tileImagery._texture.destroy();
        });

        if (typeof this.children !== 'undefined') {
            while (this.children.length > 0) {
                this.children.pop().destroy();
            }
        }

        return destroyObject(this);
    };

    Tile.prototype.freeResources = function() {
        this.state = TileState.UNLOADED;
        this.doneLoading = false;
        this.renderable = false;

        if (typeof this.vertexArray !== 'undefined') {
            var indexBuffer = this.vertexArray.getIndexBuffer();

            this.vertexArray = this.vertexArray && this.vertexArray.destroy();
            this.vertexArray = undefined;

            if (!indexBuffer.isDestroyed() && typeof indexBuffer.referenceCount !== 'undefined') {
                --indexBuffer.referenceCount;
                if (indexBuffer.referenceCount === 0) {
                    indexBuffer.destroy();
                }
            }
        }

        if (typeof this.geometry !== 'undefined' && typeof this.geometry.destroy !== 'undefined') {
            this.geometry.destroy();
        }
        this.geometry = undefined;

        if (typeof this.transformedGeometry !== 'undefined' && typeof this.transformedGeometry.destroy !== 'undefined') {
            this.transformedGeometry.destroy();
        }
        this.transformedGeometry = undefined;

        var imagery = this.imagery;
        Object.keys(imagery).forEach(function(key) {
            var tileImagery = imagery[key];
            tileImagery.destroy();
        });
        this.imagery = [];

        if (typeof this.children !== 'undefined') {
            for (var i = 0; i < this.children.length; ++i) {
                this.children[i].freeResources();
            }
        }
    };

    return Tile;
});