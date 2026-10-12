import * as path from "path";
import * as Webpack from 'webpack';

import type __ from 'webpack-dev-server';

import merge from 'webpack-merge';
import common from './webpack.common';

export default merge(common, {
    mode: 'development',

    devtool: 'eval-cheap-module-source-map' as any,

    devServer: {
        host: 'localhost',
        // wirepane: next to the server's 45456/45457, clear of the 8080 that so many dev servers use
        port: 45458,
        historyApiFallback: true,
        client: {
            overlay: {
                runtimeErrors: (error) => {
                    const IGNORED_RUNTIME_ERRORS = [
                        'ResizeObserver loop completed with undelivered notifications.',
                        'ResizeObserver loop limit exceeded'
                    ];

                    return !IGNORED_RUNTIME_ERRORS.includes(error.message);
                }
            }
        }
    },

    module: {
        rules: [
            {
                test: /\.js$/,
                enforce: 'pre',
                loader: 'source-map-loader',
                exclude: [
                    path.join(__dirname, '..', 'node_modules', 'monaco-editor'),
                    path.join(__dirname, '..', 'node_modules', 'subscriptions-transport-ws'),
                    path.join(__dirname, '..', '..', 'mockttp', 'node_modules', 'subscriptions-transport-ws'),
                    path.join(__dirname, '..', 'node_modules', 'js-beautify'),
                    path.join(__dirname, '..', 'node_modules', 'graphql-subscriptions'),
                ]
            }
        ]
    },

    plugins: [
        new Webpack.DefinePlugin({
            'process.env.DISABLE_UPDATES': 'true'
        })
    ]
});
