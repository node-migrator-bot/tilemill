/**
 * Server-side Backbone implementation for TileMill. This module should be
 * required instead of directly requiring Backbone.
 */
var _ = require('underscore')._,
    Backbone = require('../modules/backbone/backbone.js'),
    settings = require('settings'),
    rmrf = require('rm-rf'),
    fs = require('fs'),
    Step = require('step'),
    path = require('path');

/**
 * Override Backbone.sync() for the server-side context. Uses TileMill-specific
 * file storage methods for model CRUD operations.
 */
Backbone.sync = function(method, model, success, error) {
    switch (method) {
    case 'read':
        if (model.id) {
            load(model, function(err, model) {
                return err ? error(err) : success(model);
            });
        } else {
            loadAll(model, function(err, model) {
                return err ? error(err) : success(model);
            });
        }
        break;
    case 'create':
        create(model, function(err, model) {
            return err ? error(err) : success(model);
        });
        break;
    case 'update':
        update(model, function(err, model) {
            return err ? error(err) : success(model);
        });
        break;
    case 'delete':
        destroy(model, function(err, model) {
            return err ? error(err) : success(model);
        });
        break;
    }
};

/**
 * Load a single model. Requires that model.id be populated.
 */
function load(model, callback) {
    var modelPath = path.join(settings.files, model.type);
    modelPath = (model.type == 'project') ? path.join(modelPath, model.id) : modelPath;
    var extension = (model.type == 'project') ? 'mml' : 'json';
    fs.readFile(path.join(modelPath, model.id + '.' + extension), 'utf-8',
    function(err, data) {
        if (err || !data) {
            return callback(new Error('Error reading model file.'));
        }
        var object = JSON.parse(data);
        // Set the object ID explicitly for multiple-load scenarios where
        // model parse()/set() is bypassed.
        object.id = model.id;
        if (model.type === 'project' && object.Stylesheet && object.Stylesheet.length > 0) {
            Step(
                function() {
                    var group = this.group();
                    _.each(object.Stylesheet, function(filename, index) {
                        fs.readFile(
                            path.join(modelPath, filename),
                            'utf-8',
                            group()
                        );
                    });
                },
                function(err, files) {
                    object.Stylesheet = _.reduce(
                        object.Stylesheet,
                        function(memo, filename, index) {
                            if (typeof files[index] !== 'undefined') {
                                memo.push({
                                    id: filename,
                                    data: files[index]
                                });
                            }
                            return memo;
                        },
                        []
                    );
                    return callback(null, object);
                }
            );
        }
        else {
            return callback(null, object);
        }
    });
};

/**
 * Load an array of all models.
 */
function loadAll(model, callback) {
    var basepath = path.join(settings.files, model.type);
    Step(
        function() {
            path.exists(basepath, this);
        },
        function(exists) {
            if (!exists) {
                fs.mkdir(basepath, 0777, this);
            } else {
                this();
            }
        },
        function() {
            fs.readdir(basepath, this);
        },
        function(err, files) {
            if (err) {
                return this(new Error('Error reading model directory.'));
            }
            else if (files.length === 0) {
                return this();
            }
            var group = this.group();
            for (var i = 0; i < files.length; i++) {
                if (model.type === 'project') {
                    var id = files[i];
                } else {
                    var id = path.basename(files[i], '.json');
                }
                load({ id: id, type: model.type }, group());
            }
        },
        function(err, models) {
            // Ignore errors from loading individual models (e.g.
            // don't let one bad apple spoil the collection).
            models = _.select(models, function(model) {
                return (typeof model === 'object');
            });
            return callback(null, models);
        }
    );
};

/**
 * Create a new model.
 * @TODO assign a model id if not present.
 */
function create(model, callback) {
    if (model.type === 'project') {
        saveProject(model, callback);
    } else {
        save(model, callback);
    }
};

/**
 * Update an existing model.
 */
function update(model, callback) {
    if (model.type === 'project') {
        saveProject(model, callback);
    } else {
        save(model, callback);
    }
};

/**
 * Destroy (delete, remove, etc.) a model.
 * - Project: rm rf the project directory.
 * - Export: track and and kill the export file in addition to the model.
 * - All others: rm the model json file.
 */
function destroy(model, callback) {
    switch (model.type) {
    case 'project':
        var modelPath = path.join(settings.files, model.type, model.id);
        rmrf(modelPath, function() { return callback(null, model) });
        break;
    case 'export':
        var filepath;
        Step(
            function() {
                load(model, this);
            },
            function(err, data) {
                if (data && data.filename) {
                    filepath = path.join(settings.export_dir, data.filename);
                    path.exists(filepath, this);
                }
                else {
                    this(false);
                }
            },
            function(remove) {
                if (remove) {
                    fs.unlink(filepath, this);
                }
                else {
                    this();
                }
            },
            function() {
                var modelPath = path.join(settings.files, model.type, model.id + '.json');
                fs.unlink(modelPath, function() { return callback(null, model) });
            }
        );
        break;
    default:
        var modelPath = path.join(settings.files, model.type, model.id + '.json');
        fs.unlink(modelPath, function() { return callback(null, model) });
        break;
    }
};

/**
 * Save a Project. Called by create/update.
 *
 * Special case for projects creates a subdirectory per project and does
 * additional splitting out of subproperties (stylesheets) into separate files.
 */
function saveProject(model, callback) {
    var basePath = path.join(settings.files, model.type);
    var modelPath = path.join(settings.files, model.type, model.id);
    Step(
        function() {
            path.exists(basePath, this);
        },
        function(exists) {
            if (!exists) {
                fs.mkdir(basePath, 0777, this);
            } else {
                this();
            }
        },
        function() {
            path.exists(modelPath, this);
        },
        function(exists) {
            if (!exists) {
                fs.mkdir(modelPath, 0777, this);
            } else {
                this();
            }
        },
        function() {
            fs.readdir(modelPath, this);
        },
        function(err, files) {
            // Remove any stale files in the project directory.
            var group = this.group();
            var stylesheets = model.get('Stylesheet') || [];
            var stale = _.select(files, function(filename) {
                if (filename === (model.id + '.mml')) {
                    return false;
                } else if (_.pluck(stylesheets, 'id').indexOf(filename) !== -1) {
                    return false;
                }
                return true;
            });
            if (stale.length) {
                for (var i = 0; i < stale.length; i++) {
                    fs.unlink(path.join(modelPath, stale[i]), group());
                }
            }
            else {
                group()();
            }
        },
        function() {
            // Hard clone the model JSON before doing adjustments to the data
            // based on writing separate stylesheets.
            var data = JSON.parse(JSON.stringify(model.toJSON()));
            var files = [];
            if (data.id) {
                delete data.id;
            }
            if (data.Stylesheet) {
                _.each(data.Stylesheet, function(stylesheet, key) {
                    if (stylesheet.id) {
                        files.push({
                            filename: stylesheet.id,
                            data: stylesheet.data
                        });
                        data.Stylesheet[key] = stylesheet.id;
                    }
                });
            }
            files.push({
                filename: model.id + '.mml',
                data: JSON.stringify(data)
            });

            var group = this.group();
            for (var i = 0; i < files.length; i++) {
                fs.writeFile(
                    path.join(modelPath, files[i].filename),
                    files[i].data,
                    group()
                );
            }
        },
        function() {
            callback(null, model);
        }
    );
}

/**
 * Save a model. Called by create/update.
 */
function save(model, callback) {
    var basePath = path.join(settings.files, model.type);
    Step(
        function() {
            path.exists(basePath, this);
        },
        function(exists) {
            if (!exists) {
                fs.mkdir(basePath, 0777, this);
            } else {
                this();
            }
        },
        function() {
            fs.writeFile(
                path.join(basePath, model.id + '.json'),
                JSON.stringify(model.toJSON()),
                this
            );
        },
        function() {
            callback(null, model);
        }
    );
}

module.exports = Backbone;
